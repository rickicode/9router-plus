import { getModelInfoCore } from "open-sse/services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse } from "open-sse/utils/error.js";
import { checkFallbackError, isAccountUnavailable, getUnavailableUntil, getEarliestRateLimitedUntil, formatRetryAfter } from "open-sse/services/accountFallback.js";
import { getComboModelsFromData, handleComboChat } from "open-sse/services/combo.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { refreshTokenByProvider } from "../services/tokenRefresh.js";
import { parseApiKey, extractBearerToken } from "../utils/apiKey.js";
import { selectCredential } from "../services/routing.js";
import { recordUsage, recordUsageEvent } from "../services/usage.js";
import { getRuntimeConfig, updateRuntimeProviderState } from "../services/storage.js";
import { applyCompactedMessages, buildAutoCompactPlan } from "open-sse/utils/autoCompactCore.js";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const refreshLocks = new Map();
const morphCompactRotationCursors = new Map();
const morphCompactKeyCooldowns = new Map();

function getMorphCompactKeyId(entry) {
  return typeof entry?.email === "string" && entry.email.trim() ? entry.email.trim() : null;
}

function getMorphCompactCooldownKey(machineId, entry) {
  const keyId = getMorphCompactKeyId(entry);
  return keyId ? `${machineId}:${keyId}` : null;
}

function isMorphCompactKeyCooledDown(machineId, entry) {
  const cooldownKey = getMorphCompactCooldownKey(machineId, entry);
  if (!cooldownKey) return false;
  const expiresAt = morphCompactKeyCooldowns.get(cooldownKey);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    morphCompactKeyCooldowns.delete(cooldownKey);
    return false;
  }
  return true;
}

function setMorphCompactKeyCooldown(machineId, entry, status) {
  const cooldownKey = getMorphCompactCooldownKey(machineId, entry);
  if (!cooldownKey) return;
  const durationMs = status === 401 ? 30 * 60 * 1000 : status === 429 ? 60 * 1000 : 0;
  if (durationMs > 0) {
    morphCompactKeyCooldowns.set(cooldownKey, Date.now() + durationMs);
  }
}

function clearMorphCompactKeyCooldown(machineId, entry) {
  const cooldownKey = getMorphCompactCooldownKey(machineId, entry);
  if (cooldownKey) morphCompactKeyCooldowns.delete(cooldownKey);
}

function getMorphCompactKeyOrder(machineId, morphSettings) {
  const apiKeys = Array.isArray(morphSettings?.apiKeys)
    ? morphSettings.apiKeys.filter((entry) => entry?.key && entry.status !== "inactive" && entry.isExhausted !== true && entry.isActive !== false)
    : [];
  const availableKeys = apiKeys.filter((entry) => !isMorphCompactKeyCooledDown(machineId, entry));
  const eligibleKeys = availableKeys.length > 0 ? availableKeys : apiKeys;
  if (eligibleKeys.length <= 1 || morphSettings?.roundRobinEnabled !== true) return eligibleKeys;

  const currentIndex = morphCompactRotationCursors.get(machineId) || 0;
  const selectedIndex = currentIndex % eligibleKeys.length;
  morphCompactRotationCursors.set(machineId, (selectedIndex + 1) % eligibleKeys.length);
  return eligibleKeys.map((_, offset) => eligibleKeys[(selectedIndex + offset) % eligibleKeys.length]);
}

function isMorphCompactRetryableStatus(status) {
  return status === 401 || status === 429 || status >= 500;
}

function getCompactUsageTokens(usage = {}) {
  return {
    input: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
    output: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
  };
}

function recordCompactUsage({ status, startedAt, responsePayload = null, error = null }) {
  const tokens = getCompactUsageTokens(responsePayload?.usage || {});
  recordUsageEvent({
    type: "morph",
    endpoint: "/v1/chat/auto-compact",
    provider: "morph",
    model: responsePayload?.model || "morph-compactor",
    connectionId: null,
    status,
    tokensInput: tokens.input,
    tokensOutput: tokens.output,
    error,
    latencyMs: Date.now() - startedAt,
  });
}

async function maybeAutoCompactBody(body, data, machineId) {
  const startedAt = Date.now();
  const plan = buildAutoCompactPlan(body, data?.settings?.autoCompact);
  if (!plan.ok) {
    if (plan.reason !== "disabled" && plan.reason !== "below minimum messages") {
      log.warn("COMPACT", `Auto compact skipped: ${plan.reason}`);
    }
    return body;
  }

  const morph = data?.settings?.morph;
  const apiKeys = getMorphCompactKeyOrder(machineId, morph);
  if (!morph?.baseUrl || apiKeys.length === 0) {
    log.warn("COMPACT", "Auto compact skipped: Morph is not configured");
    return body;
  }

  const upstreamUrl = new URL("/v1/compact", `${String(morph.baseUrl).replace(/\/+$/, "")}/`).toString();
  const requestBody = JSON.stringify(plan.payload);
  log.info("COMPACT", `Auto compact starting for ${plan.messages.length} messages`, {
    messages: plan.messages.length,
    tools: Array.isArray(body?.tools) ? body.tools.length : 0,
    inputFormat: Array.isArray(body?.input),
  });
  let lastStatus = null;
  let lastError = null;

  for (const [index, entry] of apiKeys.entries()) {
    try {
      const response = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${entry.key}`,
          "Content-Type": "application/json",
        },
        body: requestBody,
        signal: AbortSignal.timeout(25_000),
      });

      if (!response.ok) {
        lastStatus = response.status;
        setMorphCompactKeyCooldown(machineId, entry, response.status);
        if (index < apiKeys.length - 1 && isMorphCompactRetryableStatus(response.status)) {
          continue;
        }
        recordCompactUsage({
          status: response.status,
          startedAt,
          error: `Morph returned ${response.status}`,
        });
        log.warn("COMPACT", `Auto compact skipped: Morph returned ${response.status}`);
        return body;
      }

      const result = await response.json();
      if (!Array.isArray(result?.messages) || result.messages.length === 0) {
        recordCompactUsage({
          status: response.status,
          startedAt,
          responsePayload: result,
          error: "Morph returned no messages",
        });
        log.warn("COMPACT", "Auto compact skipped: Morph returned no messages");
        return body;
      }

      const compactedBody = applyCompactedMessages(body, plan.key, plan.entries, result.messages);
      if (!compactedBody) {
        recordCompactUsage({
          status: response.status,
          startedAt,
          responsePayload: result,
          error: "Morph returned incompatible message shape",
        });
        log.warn("COMPACT", "Auto compact skipped: Morph returned incompatible message shape");
        return body;
      }

      clearMorphCompactKeyCooldown(machineId, entry);
      recordCompactUsage({
        status: response.status,
        startedAt,
        responsePayload: result,
      });
      log.info("COMPACT", `Auto compact completed for ${plan.messages.length} messages`, {
        messages: plan.messages.length,
        tools: Array.isArray(compactedBody?.tools) ? compactedBody.tools.length : 0,
        inputFormat: Array.isArray(compactedBody?.input),
        compressionRatio: plan.payload.compression_ratio,
      });
      return compactedBody;
    } catch (error) {
      lastError = error;
      if (index < apiKeys.length - 1) {
        continue;
      }
      recordCompactUsage({
        status: 0,
        startedAt,
        error: error?.message || String(error),
      });
      log.warn("COMPACT", `Auto compact skipped: ${error?.message || error}`);
      return body;
    }
  }

  log.warn("COMPACT", `Auto compact skipped: ${lastStatus ? `Morph returned ${lastStatus}` : lastError?.message || "no Morph key succeeded"}`);
  return body;
}

async function getModelInfo(modelStr, machineId, env) {
  const data = await getRuntimeConfig(machineId, env);
  if (!data) {
    return getModelInfoCore(modelStr, {});
  }
  return getModelInfoCore(modelStr, data?.modelAliases || {});
}

/**
 * Handle chat request
 * @param {Request} request
 * @param {Object} env
 * @param {Object} ctx
 * @param {string|null} machineIdOverride - machineId from URL (old format) or null (new format - extract from key)
 */
export async function handleChat(request, env, ctx, machineIdOverride = null) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*"
      }
    });
  }

  // Determine machineId: from URL (old) or from API key (new)
  let machineId = machineIdOverride;
  
  if (!machineId) {
    // New format: extract machineId from API key
    const apiKey = extractBearerToken(request);
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    
    const parsed = await parseApiKey(apiKey);
    if (!parsed) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key format");
    
    if (!parsed.isNewFormat || !parsed.machineId) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "API key does not contain machineId. Use /{machineId}/v1/... endpoint for old format keys.");
    }
    
    machineId = parsed.machineId;
  }

  if (!await validateApiKey(request, machineId, env)) {
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  log.info("CHAT", `${machineId} | ${body.model}`, { stream: body.stream !== false });

  const modelStr = body.model;
  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");

  // Check if model is a combo
  const data = await getRuntimeConfig(machineId, env);
  if (!data) {
    return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "Runtime config unavailable");
  }
  body = await maybeAutoCompactBody(body, data, machineId);
  const comboModels = getComboModelsFromData(modelStr, data?.combos || []);
  
  if (comboModels) {
    log.info("COMBO", `"${modelStr}" with ${comboModels.length} models`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (reqBody, model) => handleSingleModelChat(reqBody, model, machineId, env, request),
      log
    });
  }

  // Single model request
  return handleSingleModelChat(body, modelStr, machineId, env, request);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, machineId, env, request) {
  const requestStartedAt = Date.now();
  const modelInfo = await getModelInfo(modelStr, machineId, env);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("MODEL", `${provider.toUpperCase()} | ${model}`);

  const excludedConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let retryCount = 0;
  const MAX_RETRIES = 10;

  while (retryCount < MAX_RETRIES) {
    retryCount++;
    const data = await getRuntimeConfig(machineId, env);
    if (!data) {
      return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "Runtime config unavailable");
    }
    let connection;
    try {
      const apiKey = extractBearerToken(request);
      connection = selectCredential(data, provider, apiKey || 'default');
      if (!connection?.id) {
        log.debug("ROUTING", "selectCredential returned connection without id", {
          provider,
          machineId,
          selectedKeys: connection ? Object.keys(connection) : [],
        });
      }
    } catch (error) {
      log.warn("ROUTING", error.message);
      return errorResponse(HTTP_STATUS.BAD_REQUEST, error.message);
    }

    let credentials = connection;
    if (excludedConnectionIds.has(credentials?.id)) {
      // Mark initially selected credential as excluded before fallback
      if (credentials?.id) {
        excludedConnectionIds.add(credentials.id);
      }
      credentials = await getProviderCredentials(machineId, provider, env, excludedConnectionIds);
    }
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const retryAfterSec = Math.ceil((new Date(credentials.retryAfter).getTime() - Date.now()) / 1000);
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const msg = `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`;
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `${provider.toUpperCase()} | ${msg}`);
        return new Response(
          JSON.stringify({ error: { message: msg } }),
          { status, headers: { "Content-Type": "application/json", "Retry-After": String(Math.max(retryAfterSec, 1)) } }
        );
      }
      if (excludedConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      log.warn("CHAT", `${provider.toUpperCase()} | no more accounts`);
      return new Response(
        JSON.stringify({ error: lastError || "All accounts unavailable" }),
        { status: lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, headers: { "Content-Type": "application/json" } }
      );
    }

    log.debug("CHAT", `account=${credentials.id}`, { provider });

    const refreshedCredentials = await checkAndRefreshToken(machineId, provider, credentials, env);
    
    // Use shared chatCore
    const result = await handleChatCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateCredentials(machineId, credentials.id, newCreds, env);
      },
      onRequestSuccess: async () => {
        // Clear error status only if currently has error (optimization)
        await clearAccountError(machineId, credentials.id, credentials, env);
      }
    });

    if (result.success) {
      // Extract token counts from response metadata if available
      const inputTokens = body.messages?.reduce((sum, msg) => {
        return sum + (msg.content?.length || 0);
      }, 0) || 0;

      // Record usage (output tokens tracked in stream handler if needed)
      if (connection?.id) {
        recordUsage(connection.id, Math.floor(inputTokens / 4), 0);
      } else {
        log.warn("CHAT", "Cannot record usage: connection.id is undefined");
      }
      recordUsageEvent({
        type: "chat",
        endpoint: new URL(request.url).pathname,
        provider,
        model,
        connectionId: connection?.id || credentials?.id || null,
        status: result.response?.status || 200,
        tokensInput: Math.floor(inputTokens / 4),
        tokensOutput: 0,
        latencyMs: Date.now() - requestStartedAt,
      });
      return result.response;
    }

    const { shouldFallback } = checkFallbackError(result.status, result.error);

    if (shouldFallback) {
      // On error
      if (connection?.id) {
        recordUsage(connection.id, 0, 0, result.error);
      }
      recordUsageEvent({
        type: "chat",
        endpoint: new URL(request.url).pathname,
        provider,
        model,
        connectionId: connection?.id || credentials?.id || null,
        status: result.status,
        tokensInput: 0,
        tokensOutput: 0,
        error: result.error,
        latencyMs: Date.now() - requestStartedAt,
      });
      log.warn("FALLBACK", `${provider.toUpperCase()} | ${credentials.id} | ${result.status}`);
      await markAccountUnavailable(machineId, credentials.id, result.status, result.error, env);
      excludedConnectionIds.add(credentials.id);
      lastError = result.error;
      lastStatus = result.status;
      if (retryCount >= MAX_RETRIES) {
        log.error("CHAT", "Max retries exceeded, all accounts failed");
        return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "All accounts unavailable after max retries");
      }
      continue;
    }

    return result.response;
  }

  log.error("CHAT", "Max retries exceeded, all accounts failed");
  return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "All accounts unavailable after max retries");
}

async function checkAndRefreshToken(machineId, provider, credentials, env) {
  if (!credentials.expiresAt) return credentials;

  const expiresAt = new Date(credentials.expiresAt).getTime();
  if (expiresAt - Date.now() >= TOKEN_EXPIRY_BUFFER_MS) return credentials;

  const lockKey = credentials.id;

  if (refreshLocks.has(lockKey)) {
    await refreshLocks.get(lockKey);
    const data = await getRuntimeConfig(machineId, env);
    return data?.providers?.[credentials.id] || credentials;
  }

  const refreshPromise = (async () => {
    try {
      log.debug("TOKEN", `${provider.toUpperCase()} | expiring, refreshing`);
      const newCredentials = await refreshTokenByProvider(provider, credentials);
      if (newCredentials?.accessToken) {
        await updateCredentials(machineId, credentials.id, newCredentials, env);
        return {
          ...credentials,
          accessToken: newCredentials.accessToken,
          refreshToken: newCredentials.refreshToken || credentials.refreshToken,
          expiresAt: newCredentials.expiresIn
            ? new Date(Date.now() + newCredentials.expiresIn * 1000).toISOString()
            : credentials.expiresAt
        };
      }
      return credentials;
    } finally {
      refreshLocks.delete(lockKey);
    }
  })();

  refreshLocks.set(lockKey, refreshPromise);
  return await refreshPromise;
}

export async function validateApiKey(request, machineId, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const apiKey = authHeader.slice(7);
  const data = await getRuntimeConfig(machineId, env);
  if (!data) return false;
  return data?.apiKeys?.some(k => k.isActive !== false && k.key === apiKey) || false;
}

async function getProviderCredentials(machineId, provider, env, excludedConnectionIds = new Set()) {
  const data = await getRuntimeConfig(machineId, env);
  if (!data?.providers) return null;

  const excludedIds = excludedConnectionIds instanceof Set
    ? excludedConnectionIds
    : new Set(excludedConnectionIds ? [excludedConnectionIds] : []);

  const providerConnections = Object.entries(data.providers)
    .filter(([connId, conn]) => {
      if (conn.provider !== provider || !conn.isActive) return false;
      if (excludedIds.has(connId)) return false;
      if (isAccountUnavailable(conn)) return false;
      return true;
    })
    .sort((a, b) => (a[1].priority || 999) - (b[1].priority || 999));

  if (providerConnections.length === 0) {
    // Check if accounts exist but all rate limited
    const allConnections = Object.entries(data.providers)
      .filter(([, conn]) => conn.provider === provider && conn.isActive)
      .map(([, conn]) => conn);
    const earliest = getEarliestRateLimitedUntil(allConnections);
    if (earliest) {
      const unavailableConns = allConnections.filter(c => isAccountUnavailable(c));
      const earliestConn = unavailableConns.sort((a, b) => {
        const aUntil = a.nextRetryAt || a.resetAt;
        const bUntil = b.nextRetryAt || b.resetAt;
        return new Date(aUntil).getTime() - new Date(bUntil).getTime();
      })[0];
      return {
        allRateLimited: true,
        retryAfter: earliest,
        retryAfterHuman: formatRetryAfter(earliest),
        lastError: earliestConn?.reasonDetail || null,
        lastErrorCode: earliestConn?.reasonCode || null
      };
    }
    return null;
  }

  const [connectionId, connection] = providerConnections[0];

  return {
    id: connectionId,
    apiKey: connection.apiKey,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt,
    projectId: connection.projectId,
    copilotToken: connection.providerSpecificData?.copilotToken,
    providerSpecificData: connection.providerSpecificData,
    routingStatus: connection.routingStatus,
    authState: connection.authState,
    healthStatus: connection.healthStatus,
    quotaState: connection.quotaState,
    reasonCode: connection.reasonCode,
    reasonDetail: connection.reasonDetail,
    nextRetryAt: connection.nextRetryAt,
    resetAt: connection.resetAt,
    lastCheckedAt: connection.lastCheckedAt,
    updatedAt: connection.updatedAt,
    backoffLevel: connection.backoffLevel
  };
}

async function markAccountUnavailable(machineId, connectionId, status, errorText, env) {
  const updated = await updateRuntimeProviderState(machineId, connectionId, (conn) => {
    const backoffLevel = conn.backoffLevel || 0;
    const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);
    const rateLimitedUntil = getUnavailableUntil(cooldownMs);
    const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";

    const nowIso = new Date().toISOString();
    conn.backoffLevel = newBackoffLevel ?? backoffLevel;
    conn.routingStatus = "blocked";
    conn.healthStatus = status >= 500 ? "unhealthy" : "degraded";
    conn.quotaState = status === 429 ? "exhausted" : "ok";
    conn.authState = (status === 401 || status === 403) ? "invalid" : "ok";
    conn.reasonCode = status === 429
      ? "quota_exhausted"
      : ((status === 401 || status === 403) ? "auth_invalid" : "usage_request_failed");
    conn.reasonDetail = reason;
    conn.nextRetryAt = rateLimitedUntil;
    conn.resetAt = rateLimitedUntil;
    conn.lastCheckedAt = nowIso;
  }, env);
  const conn = updated?.providers?.[connectionId];
  if (!conn) return;

  log.warn("ACCOUNT", `${connectionId} | unavailable until ${conn.nextRetryAt} (backoff=${conn.backoffLevel || 0})`);
}

async function clearAccountError(machineId, connectionId, currentCredentials, env) {
  // Only update if currently has error status (optimization)
  const hasError =
    currentCredentials.routingStatus && currentCredentials.routingStatus !== "eligible" ||
    currentCredentials.quotaState && currentCredentials.quotaState !== "ok" ||
    currentCredentials.authState && currentCredentials.authState !== "ok" ||
    currentCredentials.healthStatus && currentCredentials.healthStatus !== "healthy" ||
    currentCredentials.reasonCode && currentCredentials.reasonCode !== "unknown" ||
    currentCredentials.reasonDetail ||
    currentCredentials.nextRetryAt ||
    currentCredentials.resetAt;

  if (!hasError) return;

  const updated = await updateRuntimeProviderState(machineId, connectionId, (conn) => {
    conn.backoffLevel = 0;
    conn.routingStatus = "eligible";
    conn.authState = "ok";
    conn.healthStatus = "healthy";
    conn.quotaState = "ok";
    conn.reasonCode = "unknown";
    conn.reasonDetail = null;
    conn.nextRetryAt = null;
    conn.resetAt = null;
    conn.lastCheckedAt = new Date().toISOString();
  }, env);
  if (!updated?.providers?.[connectionId]) return;

  log.info("ACCOUNT", `${connectionId} | error cleared`);
}

async function updateCredentials(machineId, connectionId, newCredentials, env) {
  const updated = await updateRuntimeProviderState(machineId, connectionId, (conn) => {
    conn.accessToken = newCredentials.accessToken;
    if (newCredentials.refreshToken) conn.refreshToken = newCredentials.refreshToken;
    if (newCredentials.expiresIn) {
      conn.expiresAt = new Date(Date.now() + newCredentials.expiresIn * 1000).toISOString();
      conn.expiresIn = newCredentials.expiresIn;
    }
  }, env);
  if (!updated?.providers?.[connectionId]) return;

  log.debug("TOKEN", `credentials updated in runtime cache | ${connectionId}`);
}
