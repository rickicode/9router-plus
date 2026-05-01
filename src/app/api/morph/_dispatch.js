import { MORPH_CAPABILITY_UPSTREAMS, atomicUpdateSettings } from "@/lib/localDb.js";
import {
  createMorphDispatchError,
  executeWithMorphKeyFailover,
} from "@/lib/morph/keySelection.js";
import { buildMorphKeyStatusPatch } from "@/app/api/morph/test-key/route.js";
import { getDefaultMorphModel, saveMorphUsage } from "@/lib/morphUsageDb.js";
import { trackPendingRequest } from "@/lib/usageDb.js";

const DEFAULT_MORPH_UPSTREAM_TIMEOUT_MS = 25_000;
const ANSI_PINK = "\x1b[38;5;205m";
const ANSI_RESET = "\x1b[0m";
const MORPH_UPSTREAM_HEADERS = {
  "Accept-Encoding": "identity",
};

function buildUpstreamUrl(baseUrl, upstreamPath) {
  return new URL(upstreamPath, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function inferMorphModel(payload, capability) {
  if (typeof payload?.model === "string" && payload.model.trim()) {
    return payload.model.trim();
  }

  return getDefaultMorphModel(capability);
}

function normalizeUsageTokens(usage = {}) {
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;

  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

function getMorphRequestPath(req) {
  return req.nextUrl?.pathname || new URL(req.url).pathname;
}

function getMorphRequestSource(req) {
  const pathname = getMorphRequestPath(req);
  return pathname.startsWith("/v1/") ? "v1" : pathname.startsWith("/morphllm/") ? "morphllm" : "morph-api";
}

function getMorphClientEndpoint(req) {
  return getMorphRequestPath(req);
}

function resolveMorphUpstreamTimeoutMs() {
  const rawValue = process.env.MORPH_UPSTREAM_TIMEOUT_MS;
  const timeoutMs = Number(rawValue);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_MORPH_UPSTREAM_TIMEOUT_MS;
}

function shouldSyncSuccessfulMorphKeyState(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  return entry.status !== "active"
    || entry.isExhausted === true
    || Boolean(entry.lastError);
}

function createMorphUpstreamTimeoutError(timeoutMs, cause) {
  return createMorphDispatchError(`Morph upstream request timed out after ${timeoutMs}ms`, {
    cause,
    name: "AbortError",
    code: "MORPH_UPSTREAM_TIMEOUT",
    dispatchStarted: true,
  });
}

function logMorphEndpointAccess(req, requestLabel, requestPayload, upstreamPath) {
  const pathname = getMorphRequestPath(req);
  if (!pathname.startsWith("/morphllm")) {
    return;
  }

  const fallbackCapability = typeof requestLabel === "string" && requestLabel.startsWith("morph:")
    ? requestLabel.slice("morph:".length)
    : null;
  const model = typeof requestPayload?.model === "string" && requestPayload.model.trim()
    ? requestPayload.model.trim()
    : getDefaultMorphModel(fallbackCapability);
  const upstreamLabel = upstreamPath ? ` upstream=${upstreamPath}` : "";

  console.log(`${ANSI_PINK}[morph] ${req.method || "POST"} ${pathname}${upstreamLabel} model=${model}${ANSI_RESET}`);
}

function parseMorphRequestPayload(requestBody) {
  if (!requestBody) {
    return null;
  }

  try {
    return JSON.parse(requestBody);
  } catch {
    return null;
  }
}

function shouldBufferMorphResponse(response, requestPayload) {
  if (!response?.ok) return true;
  if (requestPayload?.stream === true) return false;
  const contentType = String(response.headers?.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/event-stream")) return false;
  return contentType.includes("application/json");
}

async function readResponseTextSafely(response, context) {
  if (!response) {
    return null;
  }

  try {
    return await response.clone().text();
  } catch (error) {
    console.warn(`[morph] Skipping ${context} body read:`, error);
    return null;
  }
}

function doesMorphKeyPatchChange(entry, patch) {
  if (!entry || !patch) return false;
  return entry.status !== patch.status
    || entry.isExhausted !== patch.isExhausted
    || (entry.lastError || "") !== (patch.lastError || "");
}

async function updateMorphKeyState(email, patch) {
  if (!email) return false;

  let changed = false;
  await atomicUpdateSettings((current) => {
    const morph = current?.morph || {};
    const apiKeys = Array.isArray(morph.apiKeys) ? morph.apiKeys : [];
    const nextApiKeys = apiKeys.map((entry) => {
      if (entry?.email !== email) {
        return entry;
      }

      if (!doesMorphKeyPatchChange(entry, patch)) {
        return entry;
      }

      changed = true;
      return { ...entry, ...patch };
    });

    if (!changed) {
      return current;
    }

    return {
      ...current,
      morph: {
        ...morph,
        apiKeys: nextApiKeys,
      },
    };
  });

  return changed;
}

async function applyMorphResponseKeyState(email, status, responseText) {
  if (!email) return;

  const patch = buildMorphKeyStatusPatch({
    status,
    responseText,
    fallbackLabel: `HTTP ${status}`,
  });

  await updateMorphKeyState(email, patch);
}

async function persistMorphUsage({ capability, req, requestPayload, response, responseText, error, apiKey, email }) {
  const model = inferMorphModel(requestPayload, capability);
  let usagePayload = null;

  if (responseText) {
    try {
      usagePayload = JSON.parse(responseText)?.usage || null;
    } catch {
      usagePayload = null;
    }
  }

  const status = response && response.ok ? "ok" : "error";

  return saveMorphUsage({
    capability,
    entrypoint: getMorphClientEndpoint(req),
    source: getMorphRequestSource(req),
    method: req.method || "POST",
    model,
    requestedModel: typeof requestPayload?.model === "string" ? requestPayload.model : null,
    apiKey,
    apiKeyLabel: email || "Unknown email",
    upstreamStatus: response?.status ?? null,
    status,
    tokens: normalizeUsageTokens(usagePayload || {}),
    error: error ? String(error?.message || error) : null,
  }, { propagateError: true });
}

export async function dispatchMorphCapability({ capability, req, morphSettings, requestBody: providedRequestBody = null, requestPayload: providedRequestPayload = undefined, upstreamTarget: providedUpstreamTarget = null, requestLabel: providedRequestLabel = null }) {
  const upstreamTarget = providedUpstreamTarget || MORPH_CAPABILITY_UPSTREAMS[capability];

  if (!upstreamTarget) {
    throw new Error(`Unsupported Morph capability: ${capability}`);
  }

  const requestLabel = providedRequestLabel || `morph:${capability}`;
  const clientEndpoint = getMorphClientEndpoint(req);
  const requestSource = getMorphRequestSource(req);
  const timeoutMs = resolveMorphUpstreamTimeoutMs();
  const upstreamUrl = buildUpstreamUrl(morphSettings.baseUrl, upstreamTarget.path);
  trackPendingRequest(requestLabel, "morph", capability, true, false, { endpoint: clientEndpoint, target: upstreamTarget.path });

  let requestBody = typeof providedRequestBody === "string" ? providedRequestBody : null;
  let requestPayload = providedRequestPayload;
  let usedApiKey = null;
  let usedEmail = null;

  try {
    if (requestBody === null) {
      requestBody = await req.text().catch((cause) => {
        throw createMorphDispatchError("Failed to read Morph request body", {
          cause,
          dispatchStarted: false,
        });
      });
    }

    if (requestPayload === undefined) {
      requestPayload = parseMorphRequestPayload(requestBody);
    }

    logMorphEndpointAccess(req, requestLabel, requestPayload, upstreamTarget.path);

    const upstreamResponse = await executeWithMorphKeyFailover({
      apiKeys: morphSettings?.apiKeys,
      roundRobinEnabled: morphSettings?.roundRobinEnabled,
      rotationKey: capability,
      execute: async ({ apiKey, email, attempt, totalKeys }) => {
        usedApiKey = apiKey;
        usedEmail = email;
        const keyEntry = Array.isArray(morphSettings?.apiKeys)
          ? morphSettings.apiKeys.find((entry) => entry?.email === email)
          : null;
        const response = await fetch(
          upstreamUrl,
          {
            method: upstreamTarget.method,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              ...MORPH_UPSTREAM_HEADERS,
            },
            body: requestBody,
            signal: AbortSignal.timeout(timeoutMs),
          }
        ).catch((cause) => {
          if (cause?.name === "AbortError") {
            throw createMorphUpstreamTimeoutError(timeoutMs, cause);
          }

          throw createMorphDispatchError("Morph upstream request failed", {
            cause,
            dispatchStarted: true,
          });
        });

        if (response.ok) {
          if (shouldSyncSuccessfulMorphKeyState(keyEntry)) {
            const nextPatch = buildMorphKeyStatusPatch({
              status: response.status,
              responseText: "",
              fallbackLabel: `HTTP ${response.status}`,
            });
            void updateMorphKeyState(email, nextPatch).catch((stateError) => {
              console.error("[morph] Failed to persist successful key state:", stateError);
            });
          }
          return response;
        }

        const responseText = await readResponseTextSafely(response, "error");
        const nextPatch = buildMorphKeyStatusPatch({
          status: response.status,
          responseText: responseText || "",
          fallbackLabel: `HTTP ${response.status}`,
        });

        await updateMorphKeyState(email, nextPatch);

        if ((nextPatch.status === "inactive" || nextPatch.isExhausted === true) && attempt < totalKeys - 1) {
          throw createMorphDispatchError(`Morph upstream rejected key ${email || "unknown"}`, {
            status: response.status,
            code: nextPatch.status === "inactive" ? "MORPH_API_KEY_INVALID" : "MORPH_API_KEY_EXHAUSTED",
            dispatchStarted: true,
          });
        }

        return response;
      },
    });

    const responseText = shouldBufferMorphResponse(upstreamResponse, requestPayload)
      ? await readResponseTextSafely(upstreamResponse, "usage")
      : null;

    const persistUsagePromise = persistMorphUsage({
      capability,
      req,
      requestPayload,
      response: upstreamResponse,
      responseText,
      error: null,
      apiKey: usedApiKey,
      email: usedEmail,
    }).catch((persistError) => {
      console.error("[morph] Failed to persist Morph usage:", persistError);
    });

    trackPendingRequest(requestLabel, "morph", capability, false, !upstreamResponse.ok, { endpoint: clientEndpoint, target: upstreamTarget.path, upstreamStatus: upstreamResponse.status });

    void persistUsagePromise;

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamResponse.headers,
    });
  } catch (error) {
    if (requestBody) {
      try {
        await persistMorphUsage({
          capability,
          req,
          requestPayload,
          response: null,
          responseText: null,
          error,
          apiKey: usedApiKey,
          email: usedEmail,
        });
      } catch (persistError) {
        console.error("[morph] Failed to persist Morph usage after error:", persistError);
      }
    }

    trackPendingRequest(requestLabel, "morph", capability, false, true, { endpoint: clientEndpoint, target: upstreamTarget.path, source: requestSource });
    throw error;
  }
}
