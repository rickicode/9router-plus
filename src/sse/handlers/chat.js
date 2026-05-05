import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { PROVIDER_MODELS } from "@/shared/constants/models";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { attachChatSlotRelease, tryAcquireChatSlot } from "@/lib/chat/concurrencyLimiter.js";
import { maybeAutoCompactChatBody } from "@/lib/chat/autoCompact.js";
import { setChatRuntimeSettings } from "open-sse/utils/abort.js";

const codexModelIds = new Set((PROVIDER_MODELS.cx || []).map((entry) => entry?.id).filter(Boolean));

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  // Log request endpoint and model
  const url = new URL(request.url);
  const modelStr = body.model;

  // Count messages (support both messages[] and input[] formats)
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;
  log.request("POST", `${url.pathname} | ${modelStr} | ${msgCount} msgs${toolCount ? ` | ${toolCount} tools` : ""}${effort ? ` | effort=${effort}` : ""}`);

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  setChatRuntimeSettings(settings.chatRuntime);
  const requestContext = {
    settings,
    comboModelsByName: new Map(),
  };
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = await handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  body = await maybeAutoCompactChatBody({ body, settings, request, log });
  if (clientRawRequest?.body) {
    clientRawRequest = { ...clientRawRequest, body };
  }

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  requestContext.comboModelsByName.set(modelStr, comboModels);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const routing = settings.routing || {};
    const comboStrategies = routing.comboStrategies || settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.strategy || comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || routing.comboStrategy || settings.comboStrategy || "fallback";
    
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, requestContext),
      log,
      comboName: modelStr,
      comboStrategy
    });
  }

  // Single model request
  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, requestContext);
}

/**
 * Handle single model chat request
 */
function isBareImplicitOpenAIModel(modelStr, provider, model) {
  if (typeof modelStr !== "string" || modelStr.includes("/")) return false;
  if (provider !== "openai" || typeof model !== "string") return false;
  return /^(gpt-|o1|o3|o4)/i.test(model);
}

function codexHasMatchingModel(model) {
  return codexModelIds.has(model);
}

async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, requestContext = null) {
  const modelInfo = await getModelInfo(modelStr);
  const settings = requestContext?.settings ?? await getSettings();

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    let comboModels = requestContext?.comboModelsByName?.get(modelStr);
    if (comboModels === undefined) {
      comboModels = await getComboModels(modelStr);
      requestContext?.comboModelsByName?.set(modelStr, comboModels);
    }
    if (comboModels) {
      // Check for combo-specific strategy first, fallback to global
      const routing = settings.routing || {};
      const comboStrategies = routing.comboStrategies || settings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.strategy || comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || routing.comboStrategy || settings.comboStrategy || "fallback";

      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, requestContext),
        log,
        comboName: modelStr,
        comboStrategy
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  let { provider, model } = modelInfo;

  // Log model routing (alias → actual model)
  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";
  const allowCodexFallback = isBareImplicitOpenAIModel(modelStr, provider, model);
  const preferCodexFirst = allowCodexFallback && codexHasMatchingModel(model);

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  const MAX_FALLBACK_ATTEMPTS = 10;
  let fallbackAttempts = 0;
  let attemptedCodexFallback = false;

  if (preferCodexFirst && provider === "openai") {
    provider = "codex";
    log.info("ROUTING", `Bare model ${model} exists in Codex; preferring codex/${model} before openai/${model}`);
  }

  while (fallbackAttempts < MAX_FALLBACK_ATTEMPTS) {
    fallbackAttempts += 1;
    let credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (!credentials && allowCodexFallback && provider === "codex" && preferCodexFirst && !attemptedCodexFallback) {
      attemptedCodexFallback = true;
      provider = "openai";
      excludeConnectionIds.clear();
      log.info("ROUTING", `No active Codex credentials for bare model ${model}; retrying with openai/${model}`);
      credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
    }

    if (credentials?.allRateLimited && allowCodexFallback && provider === "codex" && preferCodexFirst && !attemptedCodexFallback) {
      attemptedCodexFallback = true;
      provider = "openai";
      excludeConnectionIds.clear();
      lastError = credentials.lastError || lastError;
      lastStatus = Number(credentials.lastErrorCode) || lastStatus;
      log.info("ROUTING", `Codex unavailable for bare model ${model}; retrying with openai/${model}`);
      credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
    }

    if (modelStr !== `${provider}/${model}`) {
      log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
    }

    // Command Code needs the normalized upstream slug, while native full slugs like
    // moonshotai/Kimi-K2.6 must still pass through unchanged.
    const routedModel = provider === "commandcode"
      ? model
      : (modelInfo.isCommandCode ? modelStr : `${provider}/${model}`);
    body = { ...body, model: routedModel };

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Log account selection
    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const providerThinking = (settings.providerThinking || {})[provider] || null;
    const slot = tryAcquireChatSlot({
      provider,
      connectionId: credentials.connectionId,
      limits: settings.chatRuntime,
    });
    if (!slot.ok) {
      if (slot.status === HTTP_STATUS.RATE_LIMITED) {
        log.warn("AUTH", `Account ${credentials.connectionName} at concurrency limit, trying fallback`);
        excludeConnectionIds.add(credentials.connectionId);
        lastError = slot.reason || "Account concurrency limit reached";
        lastStatus = slot.status;
        fallbackAttempts -= 1;
        continue;
      }
      return errorResponse(slot.status || HTTP_STATUS.SERVICE_UNAVAILABLE, slot.reason || "Chat service is overloaded");
    }

    let result;
    try {
      result = await handleChatCore({
        body: { ...body, model: `${provider}/${model}` },
        modelInfo: { provider, model },
        credentials: refreshedCredentials,
        log,
        clientRawRequest,
        connectionId: credentials.connectionId,
        userAgent,
        apiKey,
        ccFilterNaming: !!settings.ccFilterNaming,
        providerThinking,
        // Detect source format by endpoint + body
        sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            accessToken: newCreds.accessToken,
            refreshToken: newCreds.refreshToken,
            providerSpecificData: newCreds.providerSpecificData,
            routingStatus: "eligible",
            quotaState: "ok",
            authState: "ok",
            healthStatus: "healthy",
            reasonCode: null,
            reasonDetail: null,
            nextRetryAt: null,
            resetAt: null,
            lastCheckedAt: new Date().toISOString()
          });
        },
        onRequestSuccess: async () => {
          await clearAccountError(credentials.connectionId, credentials, model);
        }
      });
    } catch (error) {
      slot.release();
      throw error;
    }

    if (result.success) return attachChatSlotRelease(result.response, slot.release);

    slot.release();

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }

  // Guarantee termination even if selection/fallback state oscillates unexpectedly.
  log.error("CHAT", "Max fallback attempts reached", {
    provider,
    model,
    attempts: fallbackAttempts,
    maxAttempts: MAX_FALLBACK_ATTEMPTS,
  });
  return errorResponse(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    lastError || `Unable to route ${provider}/${model} after repeated fallback attempts`
  );
}
