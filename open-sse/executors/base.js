import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry } from "../config/runtimeConfig.js";
import { resolveOllamaLocalHost } from "../config/providers.js";
import { createDeadlineSignal, createTimeoutError, getCompactUpstreamTimeoutMs, getUpstreamTimeoutMs, mergeAbortSignals } from "../utils/abort.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

function attachDeadlineToResponseBody(response, deadline) {
  if (!response?.body || typeof response.body.getReader !== "function") {
    deadline.clear();
    return response;
  }

  const reader = response.body.getReader();
  let cleared = false;
  const clearDeadline = () => {
    if (cleared) return;
    cleared = true;
    deadline.clear();
  };

  const readWithDeadline = () => new Promise((resolve, reject) => {
    if (deadline.signal.aborted) {
      reject(deadline.signal.reason || createTimeoutError(0, "upstream"));
      return;
    }

    const onAbort = () => reject(deadline.signal.reason || createTimeoutError(0, "upstream"));
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    reader.read()
      .then(resolve, reject)
      .finally(() => deadline.signal.removeEventListener("abort", onAbort));
  });

  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await readWithDeadline();
        if (done) {
          clearDeadline();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        clearDeadline();
        await reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      clearDeadline();
      await reader.cancel(reason).catch(() => {});
    }
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.openai.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      const path = this.provider.includes("responses") ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.anthropic.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    if (this.provider === "ollama-local") {
      return `${resolveOllamaLocalHost(credentials)}/api/chat`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = "2023-06-01";
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log) {
    return null;
  }

  needsRefresh(credentials) {
    if (!credentials.expiresAt) return false;
    const expiresAtMs = new Date(credentials.expiresAt).getTime();
    return expiresAtMs - Date.now() < 5 * 60 * 1000;
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  getTimeoutMs(_args) {
    return this.config?.timeoutMs;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};
    const timeoutMs = this.getTimeoutMs({ model, body, stream, credentials, signal, log, proxyOptions })
      || (body?._compact ? getCompactUpstreamTimeoutMs() : getUpstreamTimeoutMs());
    
    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      const headers = this.buildHeaders(credentials, stream);

      // DEBUG: Log Command Code payload
      if (this.provider === "commandcode" && process.env.DEBUG_COMMANDCODE === "true") {
        const fs = await import("fs");
        const path = await import("path");
        const captureDir = path.join(process.cwd(), ".commandcode-captures");
        if (!fs.existsSync(captureDir)) {
          fs.mkdirSync(captureDir, { recursive: true });
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `${timestamp}-9router-request.json`;
        const filepath = path.join(captureDir, filename);
        const captureData = {
          timestamp: new Date().toISOString(),
          provider: this.provider,
          model,
          url,
          headers: { ...headers, authorization: "[REDACTED]" },
          body: transformedBody,
        };
        fs.writeFileSync(filepath, JSON.stringify(captureData, null, 2));
        console.log(`\n📝 Command Code request captured: ${filename}\n`);
      }

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      try {
        const deadline = createDeadlineSignal(timeoutMs, `${this.provider} upstream`);
        const requestSignal = mergeAbortSignals([signal, deadline.signal]);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(transformedBody),
          signal: requestSignal
        }, proxyOptions).catch((error) => {
          if (deadline.signal.aborted && error?.name === "AbortError") {
            throw deadline.signal.reason || createTimeoutError(timeoutMs, `${this.provider} upstream`);
          }
          deadline.clear();
          throw error;
        });

        const responseWithDeadline = stream
          ? response
          : attachDeadlineToResponseBody(response, deadline);
        if (stream) deadline.clear();

        // Retry based on status code config
        const { attempts: maxRetries, delayMs } = resolveRetryEntry(retryConfig[responseWithDeadline.status]);
        if (maxRetries > 0 && retryAttemptsByUrl[urlIndex] < maxRetries) {
          retryAttemptsByUrl[urlIndex]++;
          log?.debug?.("RETRY", `${responseWithDeadline.status} retry ${retryAttemptsByUrl[urlIndex]}/${maxRetries} after ${delayMs / 1000}s`);
          await responseWithDeadline.body?.cancel?.().catch(() => {});
          await new Promise(resolve => setTimeout(resolve, delayMs));
          urlIndex--;
          continue;
        }

        if (this.shouldRetry(responseWithDeadline.status, urlIndex)) {
          log?.debug?.("RETRY", `${responseWithDeadline.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = responseWithDeadline.status;
          await responseWithDeadline.body?.cancel?.().catch(() => {});
          continue;
        }

        return { response: responseWithDeadline, url, headers, transformedBody };
      } catch (error) {
        lastError = error;
        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
