import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings } from "@/lib/localDb";
import { getEligibleConnections } from "@/lib/providerHotState";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { applyLiveQuotaUpdate, getCodexLiveQuotaSignal, getConnectionAuthBlockedPatch, getConnectionRecoveryPatch, getLiveRequestRecoveryPatch, isConfirmedAuthBlockedError, isUpstreamProcessingError, syncUsageStatus } from "../../lib/usageStatus.js";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";
import { getHighThroughputSelectionEnabled } from "open-sse/utils/abort.js";

function sortByPriority(connections = []) {
  return [...connections].sort((a, b) => (a.priority || 999) - (b.priority || 999));
}

function sortByRecencyDesc(connections = []) {
  return [...connections].sort((a, b) => {
    if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
    if (!a.lastUsedAt) return 1;
    if (!b.lastUsedAt) return -1;
    return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
  });
}

function sortByRecencyAsc(connections = []) {
  return [...connections].sort((a, b) => {
    if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
    if (!a.lastUsedAt) return -1;
    if (!b.lastUsedAt) return 1;
    return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
  });
}

function hasFutureTimestamp(value) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function isCanonicalFallbackEligible(connection = {}) {
  const routingStatus = connection?.routingStatus || null;
  if (routingStatus !== "eligible") return false;

  const authState = connection?.authState || null;
  if (["expired", "invalid", "revoked"].includes(authState)) return false;

  const healthStatus = connection?.healthStatus || null;
  if (["error", "failed", "unhealthy", "down"].includes(healthStatus)) return false;

  const quotaState = connection?.quotaState || null;
  if (quotaState === "exhausted") return false;

  if (hasFutureTimestamp(connection?.nextRetryAt) || hasFutureTimestamp(connection?.resetAt)) {
    return false;
  }

  return true;
}

// Provider-scoped mutexes prevent same-provider selection races without serializing all providers.
const selectionMutexes = new Map();
const providerConnectionCache = new Map();
const roundRobinCursors = new Map();
const MUTEX_TIMEOUT_MS = 5_000;
const PROVIDER_CONNECTION_CACHE_TTL_MS = 500;

async function getCachedProviderConnections(providerId) {
  if (!getHighThroughputSelectionEnabled()) {
    return getProviderConnections({ provider: providerId, isActive: true });
  }

  const cached = providerConnectionCache.get(providerId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.connections.map((connection) => ({ ...connection }));
  }

  const connections = await getProviderConnections({ provider: providerId, isActive: true });
  providerConnectionCache.set(providerId, {
    expiresAt: now + PROVIDER_CONNECTION_CACHE_TTL_MS,
    connections: connections.map((connection) => ({ ...connection })),
  });
  return connections;
}

function selectConnectionWithMemoryCursor(selectionPool, providerId, stickyLimit) {
  if (!getHighThroughputSelectionEnabled()) return null;
  if (!Array.isArray(selectionPool) || selectionPool.length === 0) return null;

  const cursorKey = `${providerId}:${selectionPool.map((connection) => connection.id).join(",")}`;
  const cursor = roundRobinCursors.get(cursorKey) || { index: 0, stickyCount: 0 };
  const selectedIndex = cursor.index % selectionPool.length;
  const selected = selectionPool[selectedIndex];
  const stickyCount = cursor.stickyCount + 1;
  const shouldAdvance = stickyCount >= stickyLimit;

  roundRobinCursors.set(cursorKey, {
    index: shouldAdvance ? (selectedIndex + 1) % selectionPool.length : selectedIndex,
    stickyCount: shouldAdvance ? 0 : stickyCount,
  });

  return selected;
}

function getSelectionMutex(providerId) {
  return selectionMutexes.get(providerId) || Promise.resolve();
}

function setSelectionMutex(providerId, mutex) {
  selectionMutexes.set(providerId, mutex);
}

function clearSelectionMutex(providerId, mutex) {
  if (selectionMutexes.get(providerId) === mutex) {
    selectionMutexes.delete(providerId);
  }
}

function buildSelectionPool(provider, providerId, connections, excludeSet, model, centralizedEligibleConnections) {
  const availableConnections = connections.filter(c => {
    if (excludeSet.has(c.id)) return false;
    if (isModelLockActive(c, model)) return false;
    return true;
  });

  const hasCentralizedEligibility = Array.isArray(centralizedEligibleConnections);
  const hasCentralizedEligibilityData = centralizedEligibleConnections != null;
  let selectionPool = hasCentralizedEligibility
    ? sortByPriority(centralizedEligibleConnections)
    : null;

  log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}, eligible: ${hasCentralizedEligibility ? selectionPool.length : "unavailable"}`);
  connections.forEach(c => {
    const excluded = excludeSet.has(c.id);
    const locked = isModelLockActive(c, model);
    if (excluded || locked) {
      const lockUntil = getEarliestModelLockUntil(c);
      log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
    }
  });

  if (availableConnections.length === 0) {
    const lockedConns = connections.filter(c => isModelLockActive(c, model));
    const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
    const earliest = expiries.sort()[0] || null;
    if (earliest) {
      const earliestConn = lockedConns[0];
      log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | reason=${earliestConn?.reasonDetail?.slice(0, 50)}`);
      return {
        availableConnections,
        selectionPool: null,
        rateLimitedResult: {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.reasonDetail || null,
          lastErrorCode: earliestConn?.reasonCode || null,
        },
      };
    }

    log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
    return {
      availableConnections,
      selectionPool: null,
      rateLimitedResult: null,
    };
  }

  if (!Array.isArray(selectionPool)) {
    if (!hasCentralizedEligibilityData) {
      const fallbackPool = sortByPriority(availableConnections.filter(isCanonicalFallbackEligible));
      log.warn("AUTH", `${provider} | centralized eligibility unavailable, using canonical fallback (${fallbackPool.length}/${availableConnections.length})`);
      if (fallbackPool.length > 0) {
        selectionPool = fallbackPool;
      } else if (providerId === "codex") {
        log.warn("AUTH", `${provider} | centralized eligibility unavailable and no canonical Codex fallback candidates remain`);
        return {
          availableConnections,
          selectionPool: [],
          rateLimitedResult: null,
        };
      }
    }

    if (!Array.isArray(selectionPool)) {
      log.warn("AUTH", `${provider} | centralized eligibility unavailable`);
      return {
        availableConnections,
        selectionPool: null,
        rateLimitedResult: null,
      };
    }
  }

  if (selectionPool.length === 0) {
    log.warn("AUTH", `${provider} | centralized eligibility returned no routable accounts`);
    return {
      availableConnections,
      selectionPool: [],
      rateLimitedResult: null,
    };
  }

  return {
    availableConnections,
    selectionPool,
    rateLimitedResult: null,
  };
}

async function selectConnectionForStrategy(selectionPool, strategy, stickyLimit) {
  if (strategy !== "round-robin") {
    return selectionPool[0];
  }

  const selectedAt = new Date().toISOString();
  const byRecency = sortByRecencyDesc(selectionPool);
  const current = byRecency[0];
  const currentCount = current?.consecutiveUseCount || 0;

  if (current && current.lastUsedAt && currentCount < stickyLimit) {
    const connection = {
      ...current,
      lastUsedAt: selectedAt,
      consecutiveUseCount: (current.consecutiveUseCount || 0) + 1,
    };
    await updateProviderConnection(connection.id, {
      lastUsedAt: connection.lastUsedAt,
      consecutiveUseCount: connection.consecutiveUseCount,
    });
    return connection;
  }

  const nextConnection = {
    ...sortByRecencyAsc(selectionPool)[0],
    lastUsedAt: selectedAt,
    consecutiveUseCount: 1,
  };
  await updateProviderConnection(nextConnection.id, {
    lastUsedAt: nextConnection.lastUsedAt,
    consecutiveUseCount: nextConnection.consecutiveUseCount,
  });
  return nextConnection;
}

export function __resetSelectionMutexesForTests() {
  selectionMutexes.clear();
  providerConnectionCache.clear();
  roundRobinCursors.clear();
}

export async function __runWithProviderSelectionLock(providerId, callback) {
  const currentMutex = getSelectionMutex(providerId);
  let resolveMutex;
  const nextMutex = new Promise(resolve => { resolveMutex = resolve; });
  setSelectionMutex(providerId, nextMutex);

  let timeoutId;
  const mutexTimeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Mutex timeout")), MUTEX_TIMEOUT_MS);
  });

  try {
    await Promise.race([currentMutex, mutexTimeout]);
    clearTimeout(timeoutId);
    return await callback();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error?.message === "Mutex timeout") {
      log.error("AUTH", `${providerId} mutex timeout after ${MUTEX_TIMEOUT_MS}ms, forcing release`);
      if (resolveMutex) resolveMutex();
      clearSelectionMutex(providerId, nextMutex);
    }
    throw error;
  } finally {
    if (resolveMutex) resolveMutex();
    clearSelectionMutex(providerId, nextMutex);
  }
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null) {
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());

  const providerId = resolveProviderId(provider);

  if (FREE_PROVIDERS[providerId]?.noAuth) {
    return { id: "noauth", connectionName: "Public", isActive: true, accessToken: "public" };
  }

  const settings = await getSettings();

  return __runWithProviderSelectionLock(providerId, async () => {
    const connections = await getCachedProviderConnections(providerId);
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      return true;
    });

    const centralizedEligibleConnections = await getEligibleConnections(providerId, availableConnections);
    const { selectionPool, rateLimitedResult } = buildSelectionPool(
      provider,
      providerId,
      connections,
      excludeSet,
      model,
      centralizedEligibleConnections,
    );

    if (rateLimitedResult) {
      return rateLimitedResult;
    }

    if (!selectionPool || selectionPool.length === 0) {
      return null;
    }

    const routing = settings.routing || {};
    const providerOverride = (routing.providerStrategies || settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.strategy
      || providerOverride.fallbackStrategy
      || routing.strategy
      || settings.fallbackStrategy
      || "fill-first";
    const stickyLimit = providerOverride.stickyLimit
      || providerOverride.stickyRoundRobinLimit
      || routing.stickyLimit
      || settings.stickyRoundRobinLimit
      || 3;

    const connection = strategy === "round-robin"
      ? (selectConnectionWithMemoryCursor(selectionPool, providerId, stickyLimit) || await selectConnectionForStrategy(selectionPool, strategy, stickyLimit))
      : await selectConnectionForStrategy(selectionPool, strategy, stickyLimit);
    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      _connection: connection,
    };
  });
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  if (isProviderRequestValidationError(status, errorText, provider)) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = resetsAtMs - Date.now();
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const rawError = typeof errorText === "string" ? errorText : "";
  const reason = rawError.slice(0, 100) || "Provider error";
  const lockUpdate = buildModelLockUpdate(model, cooldownMs);
  const lastCheckedAt = new Date().toISOString();

  const liveQuotaSignal = getCodexLiveQuotaSignal(conn, {
    statusCode: status,
    errorText,
    errorCode: status,
  });

  const confirmedAuthFailure = (status === 401 || status === 403)
    && isConfirmedAuthBlockedError(rawError || reason, { statusCode: status });
  const authBlockedPatch = confirmedAuthFailure
    ? (getConnectionAuthBlockedPatch(rawError || reason, { lastCheckedAt, statusCode: status })
      || getConnectionAuthBlockedPatch(reason, { lastCheckedAt, statusCode: status }))
    : null;

  const normalizedReason = reason.toLowerCase();
  const isRuntimeQuotaOrRateLimited = Boolean(liveQuotaSignal)
    || status === 429
    || normalizedReason.includes("rate limit")
    || normalizedReason.includes("too many requests")
    || normalizedReason.includes("quota");

  const exhaustedRetryAt = liveQuotaSignal?.resetAt || null;
  const exhaustedReason = liveQuotaSignal?.reasonDetail || reason;
  const exhaustedReasonCode = liveQuotaSignal?.reasonCode || "quota_exhausted";

  const exhaustedPatch = !authBlockedPatch && isRuntimeQuotaOrRateLimited
    ? {
        routingStatus: "exhausted",
        healthStatus: "degraded",
        quotaState: "exhausted",
        authState: "ok",
        reasonCode: exhaustedReasonCode,
        reasonDetail: exhaustedReason,
        nextRetryAt: exhaustedRetryAt,
        resetAt: exhaustedRetryAt,
        lastCheckedAt,
      }
    : null;

  // Generic OpenAI 5xx processing errors often include only a request ID or
  // broad "error occurred while processing" text. Treat them as upstream
  // unhealthy so routing blocks the account until recovery.
  const healthBlockedPatch = !authBlockedPatch && !exhaustedPatch && isUpstreamProcessingError(status, rawError || reason)
    ? {
        routingStatus: "blocked",
        healthStatus: "unhealthy",
        quotaState: "ok",
        authState: "ok",
        reasonCode: "upstream_unhealthy",
        reasonDetail: reason,
        lastCheckedAt,
      }
    : null;

  if (liveQuotaSignal) {
    await applyLiveQuotaUpdate(conn, liveQuotaSignal);
  }

  const canonicalBlockedPatch = authBlockedPatch || exhaustedPatch || healthBlockedPatch;

  if (canonicalBlockedPatch && !liveQuotaSignal) {
    await syncUsageStatus({
      id: connectionId,
      provider: conn?.provider || provider,
    }, canonicalBlockedPatch);
  }

  const connectionPatch = {
    ...(canonicalBlockedPatch || {}),
    ...lockUpdate,
    backoffLevel: newBackoffLevel ?? backoffLevel,
  };

  if (!canonicalBlockedPatch) {
    Object.assign(connectionPatch, {
      routingStatus: "blocked",
      healthStatus: "degraded",
      quotaState: "ok",
      authState: "ok",
      reasonCode: "usage_request_failed",
      reasonDetail: reason,
      lastCheckedAt,
    });
  }

  await updateProviderConnection(connectionId, connectionPatch);

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const selectedConn = currentConnection._connection || currentConnection;
  const provider = selectedConn?.provider || currentConnection?.provider || null;
  const freshConnections = provider ? await getProviderConnections({ provider }) : [];
  const conn = freshConnections.find(c => c.id === connectionId) || selectedConn;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));
  const hasCentralizedBlockedState = [
    conn.routingStatus && conn.routingStatus !== "eligible",
    conn.quotaState && conn.quotaState !== "ok",
    conn.authState && conn.authState !== "ok",
    conn.healthStatus && conn.healthStatus !== "healthy",
    conn.reasonCode && conn.reasonCode !== "unknown",
    conn.reasonDetail,
    conn.nextRetryAt,
    conn.resetAt,
  ].some(Boolean);

  if (!hasCentralizedBlockedState && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && !hasCentralizedBlockedState) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset full router-visible blocked state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, getLiveRequestRecoveryPatch());
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

function isProviderRequestValidationError(status, errorText, provider = null) {
  if (Number(status) !== 400) return false;
  const normalized = String(errorText || "").toLowerCase();
  if (!normalized) return false;

  return normalized.includes("content_length_exceeds_threshold")
    || normalized.includes("input is too long")
    || (provider === "kiro" && normalized.includes("content length"));
}
