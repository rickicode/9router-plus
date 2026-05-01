import { getModelInfoCore } from "open-sse/services/model.js";
import { handleEmbeddingsCore } from "open-sse/handlers/embeddingsCore.js";
import { errorResponse } from "open-sse/utils/error.js";
import {
  checkFallbackError,
  isAccountUnavailable,
  getEarliestRateLimitedUntil,
  getUnavailableUntil,
  formatRetryAfter
} from "open-sse/services/accountFallback.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { parseApiKey, extractBearerToken } from "../utils/apiKey.js";
import { getRuntimeConfig, updateRuntimeProviderState } from "../services/storage.js";
import { recordUsageEvent } from "../services/usage.js";

/**
 * Handle POST /v1/embeddings and /{machineId}/v1/embeddings requests.
 *
 * Follows the same auth + fallback pattern as handleChat:
 *  1. Resolve machineId (from URL or API key)
 *  2. Validate API key
 *  3. Parse model → provider/model
 *  4. Get provider credentials with fallback loop
 *  5. Delegate to handleEmbeddingsCore (open-sse)
 *
 * @param {Request} request
 * @param {object} env - Cloudflare env bindings
 * @param {object} ctx - Execution context
 * @param {string|null} machineIdOverride - From URL path (old format), or null (new format)
 */
export async function handleEmbeddings(request, env, ctx, machineIdOverride = null) {
  const requestStartedAt = Date.now();
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*"
      }
    });
  }

  // Resolve machineId
  let machineId = machineIdOverride;

  if (!machineId) {
    const apiKey = extractBearerToken(request);
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");

    const parsed = await parseApiKey(apiKey);
    if (!parsed) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key format");

    if (!parsed.isNewFormat || !parsed.machineId) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        "API key does not contain machineId. Use /{machineId}/v1/... endpoint for old format keys."
      );
    }
    machineId = parsed.machineId;
  }

  // Validate API key
  if (!await validateApiKey(request, machineId, env)) {
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const modelStr = body.model;
  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");

  if (!body.input) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");

  log.info("EMBEDDINGS", `${machineId} | ${modelStr}`);

  // Resolve model info
  const data = await getRuntimeConfig(machineId, env);
  if (!data) return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "Runtime config unavailable");
  const modelInfo = await getModelInfoCore(modelStr, data?.modelAliases || {});
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("EMBEDDINGS_MODEL", `${provider.toUpperCase()} | ${model}`);

  // Provider credential + fallback loop (mirrors handleChat)
  const excludedConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let retryCount = 0;
  const MAX_RETRIES = 10;

  while (retryCount < MAX_RETRIES) {
    retryCount++;
    const credentials = await getProviderCredentials(machineId, provider, env, excludedConnectionIds);

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const retryAfterSec = Math.ceil(
          (new Date(credentials.retryAfter).getTime() - Date.now()) / 1000
        );
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const msg = `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`;
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("EMBEDDINGS", `${provider.toUpperCase()} | ${msg}`);
        return new Response(
          JSON.stringify({ error: { message: msg } }),
          {
            status,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(Math.max(retryAfterSec, 1))
            }
          }
        );
      }
      if (excludedConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      log.warn("EMBEDDINGS", `${provider.toUpperCase()} | no more accounts`);
      return new Response(
        JSON.stringify({ error: lastError || "All accounts unavailable" }),
        {
          status: lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    log.debug("EMBEDDINGS", `account=${credentials.id}`, { provider });

    const result = await handleEmbeddingsCore({
      body,
      modelInfo: { provider, model },
      credentials,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateCredentials(machineId, credentials.id, newCreds, env);
      },
      onRequestSuccess: async () => {
        await clearAccountError(machineId, credentials.id, credentials, env);
      }
    });

    if (result.success) {
      recordUsageEvent({
        type: "embeddings",
        endpoint: new URL(request.url).pathname,
        provider,
        model,
        connectionId: credentials.id,
        status: result.response?.status || 200,
        tokensInput: 0,
        tokensOutput: 0,
        latencyMs: Date.now() - requestStartedAt,
      });
      return result.response;
    }

    const { shouldFallback } = checkFallbackError(result.status, result.error);

    if (shouldFallback) {
      recordUsageEvent({
        type: "embeddings",
        endpoint: new URL(request.url).pathname,
        provider,
        model,
        connectionId: credentials.id,
        status: result.status,
        tokensInput: 0,
        tokensOutput: 0,
        error: result.error,
        latencyMs: Date.now() - requestStartedAt,
      });
      log.warn("EMBEDDINGS_FALLBACK", `${provider.toUpperCase()} | ${credentials.id} | ${result.status}`);
      await markAccountUnavailable(machineId, credentials.id, result.status, result.error, env);
      excludedConnectionIds.add(credentials.id);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }

  log.error("EMBEDDINGS", "Max retries exceeded, all accounts failed");
  return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "Max retries exceeded, all accounts failed");
}

// ─── Helpers (same as chat.js) ───────────────────────────────────────────────

async function validateApiKey(request, machineId, env) {
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

  log.warn("EMBEDDINGS_ACCOUNT", `${connectionId} | unavailable until ${conn.nextRetryAt}`);
}

async function clearAccountError(machineId, connectionId, currentCredentials, env) {
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

  log.info("EMBEDDINGS_ACCOUNT", `${connectionId} | error cleared`);
}

async function updateCredentials(machineId, connectionId, newCredentials, env) {
  const updated = await updateRuntimeProviderState(machineId, connectionId, (conn) => {
    conn.accessToken = newCredentials.accessToken;
    if (newCredentials.refreshToken)
      conn.refreshToken = newCredentials.refreshToken;
    if (newCredentials.expiresIn) {
      conn.expiresAt = new Date(
        Date.now() + newCredentials.expiresIn * 1000
      ).toISOString();
      conn.expiresIn = newCredentials.expiresIn;
    }
  }, env);
  if (!updated?.providers?.[connectionId]) return;

  log.debug("EMBEDDINGS_TOKEN", `credentials updated in runtime cache | ${connectionId}`);
}
