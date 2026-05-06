import "open-sse/index.js";

import { getProviderConnectionById, getSettings, updateProviderConnection } from "@/lib/localDb";
import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getExecutor } from "open-sse/executors/index.js";
import {
  applyCanonicalUsageRefresh,
  applyLiveQuotaUpdate,
  getCodexLiveQuotaSignal,
  getConnectionAuthBlockedPatch,
  getLiveRequestRecoveryPatch,
  isConfirmedAuthBlockedError,
  isAuthExpiredMessage,
  isTransientUpstreamTimeoutError,
  syncUsageStatus,
} from "@/lib/usageStatus.js";

const TRANSIENT_USAGE_RETRY_DELAY_MS = 750;
const TRANSIENT_USAGE_MAX_ATTEMPTS = 3;
const USAGE_FETCH_TIMEOUT_MS = 3000;
const TRANSIENT_CONNECTIVITY_ERROR_PATTERNS = [
  "unable to connect",
  "is the computer able to access the url",
  "fetch failed",
  "network error",
  "network request failed",
  "econnrefused",
  "enotfound",
  "eai_again",
  "etimedout",
  "socket hang up",
  "connection refused",
  "dns lookup failed",
];
const AUTH_RELATED_ERROR_PATTERNS = [
  "token invalid",
  "invalid token",
  "token expired",
  "expired",
  "refresh failed",
  "re-authorize",
  "reauthorize",
  "unauthorized",
  "unauthenticated",
  "access denied",
  "invalid grant",
  "revoked",
  "oauth",
  "access token",
  "invalid api key",
  "invalid session cookie",
  "no access token",
];

function createHttpError(message, status = 500, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createUsageFetchTimeoutError(timeoutMs = USAGE_FETCH_TIMEOUT_MS) {
  const error = new Error(`usage fetch timed out after ${timeoutMs}ms`);
  error.name = "AbortError";
  error.status = 504;
  error.code = "UPSTREAM_TIMEOUT";
  error.timeoutMs = timeoutMs;
  return error;
}

async function withUsageFetchTimeout(task, timeoutMs = USAGE_FETCH_TIMEOUT_MS) {
  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(createUsageFetchTimeoutError(timeoutMs)), timeoutMs);

    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => clearTimeout(timeoutId));
  });
}

function isTransientConnectivityError(error) {
  const message = typeof error === "string"
    ? error
    : error?.message || error?.error || error?.cause?.message || "";
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const normalizedMessage = String(message).toLowerCase();

  if (AUTH_RELATED_ERROR_PATTERNS.some((pattern) => normalizedMessage.includes(pattern))) {
    return false;
  }

  return code === "ECONNREFUSED"
    || code === "ENOTFOUND"
    || code === "EAI_AGAIN"
    || code === "ETIMEDOUT"
    || code === "ECONNRESET"
    || TRANSIENT_CONNECTIVITY_ERROR_PATTERNS.some((pattern) => normalizedMessage.includes(pattern));
}

function shouldSkipTransientUsageError(error) {
  return isTransientConnectivityError(error)
    || isTransientUpstreamTimeoutError(error, {
      statusCode: error?.status,
      errorCode: error?.code || error?.errorCode,
    });
}

function getUsageRetryLogLabel(connection = {}) {
  return connection?.email
    || connection?.displayName
    || connection?.connectionName
    || connection?.name
    || connection?.id
    || "unknown";
}

function getOperationalUsageSnapshot(connection, message, extra = {}) {
  if (connection?.usageSnapshot) {
    return {};
  }

  return {
    usageSnapshot: JSON.stringify({
      provider: connection?.provider || null,
      message,
      ...extra,
    }),
  };
}

async function refreshAndUpdateCredentials(connection, force = false, options = {}) {
  const { persistStatus = true } = options;
  const executor = getExecutor(connection.provider);
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    providerSpecificData: connection.providerSpecificData,
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  const needsRefresh = force || executor.needsRefresh(credentials);
  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  const refreshResult = await executor.refreshCredentials(credentials, console);
  if (!refreshResult) {
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw createHttpError("Failed to refresh credentials. Please re-authorize the connection.", 401);
  }

  const now = new Date().toISOString();
  const credentialPatch = {
    ...(refreshResult.accessToken ? { accessToken: refreshResult.accessToken } : {}),
    ...(refreshResult.refreshToken ? { refreshToken: refreshResult.refreshToken } : {}),
    ...(refreshResult.expiresIn
      ? { expiresAt: new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString() }
      : {}),
    ...(refreshResult.expiresAt ? { expiresAt: refreshResult.expiresAt } : {}),
    ...(refreshResult.providerSpecificData || refreshResult.copilotToken || refreshResult.copilotTokenExpiresAt
      ? {
          providerSpecificData: {
            ...(connection.providerSpecificData || {}),
            ...(refreshResult.providerSpecificData || {}),
            ...(refreshResult.copilotToken ? { copilotToken: refreshResult.copilotToken } : {}),
            ...(refreshResult.copilotTokenExpiresAt ? { copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt } : {}),
          },
        }
      : {}),
  };
  const updateData = Object.keys(credentialPatch).length > 0
    ? { updatedAt: now, ...credentialPatch }
    : {};

  if (Object.keys(updateData).length > 0) {
    await updateProviderConnection(connection.id, updateData);
  }
  const updatedConnection = { ...connection, ...updateData };

  if (persistStatus && (force || refreshResult.accessToken || refreshResult.refreshToken)) {
    await syncUsageStatus(updatedConnection, getLiveRequestRecoveryPatch({
      lastCheckedAt: now,
      usageSnapshot: updatedConnection?.usageSnapshot,
    }));
  }

  return { connection: updatedConnection, refreshed: true };
}

async function runConnectionTestOrThrow(connectionId) {
  const testResult = await testSingleConnection(connectionId, { persistStatus: false });

  if (testResult?.error === "Connection not found") {
    throw createHttpError("Connection not found", 404, { testResult, phase: "test" });
  }

  if (!testResult?.valid) {
    const message = testResult?.error || "Connection test failed";
    throw createHttpError(message, 401, { testResult, phase: "test" });
  }

  return testResult;
}

async function loadUsageConnection(connectionId) {
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) {
    throw createHttpError("Connection not found", 404);
  }

  if (connection.authType !== "oauth") {
    return { connection, usage: { message: "Usage not available for API key connections" }, skipped: true };
  }

  return { connection };
}

async function resolveGlobalExhaustedThreshold(value) {
  if (Number.isFinite(value)) {
    return value;
  }

  const settings = await getSettings();
  const threshold = Number(settings?.quotaExhaustedThresholdPercent);
  return Number.isFinite(threshold) ? threshold : undefined;
}

async function fetchUsageWithTransientRetry(connection) {
  let lastError = null;

  for (let attempt = 1; attempt <= TRANSIENT_USAGE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await withUsageFetchTimeout(() => getUsageForProvider(connection));
    } catch (usageError) {
      lastError = usageError;
      const isRetryable = shouldSkipTransientUsageError(usageError);
      const logLabel = `${connection?.provider || "provider"}:${getUsageRetryLogLabel(connection)}`;

      if (!isRetryable || attempt >= TRANSIENT_USAGE_MAX_ATTEMPTS) {
        if (isRetryable) {
          console.warn(
            `[UsageRefresh] transient usage fetch failed after ${attempt}/${TRANSIENT_USAGE_MAX_ATTEMPTS} attempts for ${logLabel}: ${usageError.message}`
          );
        }
        throw usageError;
      }

      console.warn(
        `[UsageRefresh] transient usage fetch failed on attempt ${attempt}/${TRANSIENT_USAGE_MAX_ATTEMPTS} for ${logLabel}; retrying in ${TRANSIENT_USAGE_RETRY_DELAY_MS * attempt}ms: ${usageError.message}`
      );
      await sleep(TRANSIENT_USAGE_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError || new Error("Usage fetch failed");
}

export async function refreshConnectionUsage(connectionId, options = {}) {
  const {
    runConnectionTest = false,
    globalExhaustedThreshold,
    skipTransientConnectivityErrors = false,
  } = options;

  let connection;
  let testResult = null;
  let authExpiredUsageError = null;
  const shouldPersistRefreshStatus = !skipTransientConnectivityErrors;

  try {
    const loaded = await loadUsageConnection(connectionId);
    connection = loaded.connection;
    if (loaded.skipped) {
      return { connection, usage: loaded.usage, testResult, skipped: true };
    }

    if (runConnectionTest) {
      testResult = await runConnectionTestOrThrow(connectionId);
      connection = await getProviderConnectionById(connectionId);
      if (!connection) {
        throw createHttpError("Connection not found", 404, { testResult });
      }
    }

    try {
      const result = await refreshAndUpdateCredentials(connection, !runConnectionTest, {
        persistStatus: shouldPersistRefreshStatus,
      });
      connection = result.connection;
    } catch (refreshError) {
      const lastCheckedAt = new Date().toISOString();
      await syncUsageStatus(
        connection,
        getConnectionAuthBlockedPatch(refreshError.message, {
          lastCheckedAt,
          usageSnapshot: JSON.stringify({
            provider: connection?.provider || null,
            checkedAt: lastCheckedAt,
            message: refreshError.message,
          }),
        }) || {
          routingStatus: "blocked",
          healthStatus: "degraded",
          quotaState: "ok",
          authState: "ok",
          reasonCode: "refresh_failed",
          reasonDetail: refreshError.message,
          lastCheckedAt,
          ...getOperationalUsageSnapshot(connection, refreshError.message, { checkedAt: lastCheckedAt }),
        }
      );
      throw createHttpError(`Credential refresh failed: ${refreshError.message}`, 401, {
        cause: refreshError,
        statusSynced: true,
      });
    }

    let usage;
    try {
      usage = await fetchUsageWithTransientRetry(connection);
    } catch (usageError) {
      if (!connection.refreshToken || !isAuthExpiredUsageError(usageError)) {
        usageError.testResult = testResult;
        throw usageError;
      }
      authExpiredUsageError = usageError;
      usage = { message: usageError.message || "Usage auth expired" };
    }

    if (isAuthExpiredMessage(usage) && connection.refreshToken) {
      let retryResult;
      try {
        retryResult = await refreshAndUpdateCredentials(connection, true, {
          persistStatus: shouldPersistRefreshStatus,
        });
        connection = retryResult.connection;
      } catch (retryError) {
        const lastCheckedAt = new Date().toISOString();
        const reasonDetail = authExpiredUsageError?.message
          ? `${retryError.message}; original usage error: ${authExpiredUsageError.message}`
          : retryError.message;
        await syncUsageStatus(
          connection,
          getConnectionAuthBlockedPatch(reasonDetail, {
            lastCheckedAt,
            usageSnapshot: JSON.stringify({
              provider: connection?.provider || null,
              checkedAt: lastCheckedAt,
              message: reasonDetail,
            }),
          }) || {
            routingStatus: "blocked",
            healthStatus: "degraded",
            quotaState: "ok",
            authState: "ok",
            reasonCode: "auth_expired",
            reasonDetail,
            lastCheckedAt,
            ...getOperationalUsageSnapshot(connection, reasonDetail, { checkedAt: lastCheckedAt }),
          }
        );
        throw createHttpError(`Credential refresh failed: ${retryError.message}`, 401, {
          cause: retryError,
          originalUsageError: authExpiredUsageError,
          reasonDetail,
          statusSynced: true,
          testResult,
        });
      }

      try {
        usage = await withUsageFetchTimeout(() => getUsageForProvider(connection));
      } catch (usageRetryError) {
        usageRetryError.reasonDetail = authExpiredUsageError?.message
          ? `${usageRetryError.message}; original usage error: ${authExpiredUsageError.message}`
          : usageRetryError.message;
        usageRetryError.testResult = testResult;
        throw usageRetryError;
      }
    }

    const resolvedGlobalExhaustedThreshold = await resolveGlobalExhaustedThreshold(globalExhaustedThreshold);
    await applyCanonicalUsageRefresh(connection, usage, {
      ...(Number.isFinite(resolvedGlobalExhaustedThreshold)
        ? { globalExhaustedThreshold: resolvedGlobalExhaustedThreshold }
        : {}),
    });

    return { connection, usage, testResult, skipped: false };
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (connection?.id && !error.connection) {
      error.connection = connection;
    }
    if (testResult && !error.testResult) {
      error.testResult = testResult;
    }
    if (!connection?.id || error?.statusSynced) throw error;

    if (skipTransientConnectivityErrors && shouldSkipTransientUsageError(error)) {
      return { connection, usage: null, testResult, skipped: true, skipReason: "transient_connectivity_error" };
    }

    const lastCheckedAt = new Date().toISOString();
    if (isTransientUpstreamTimeoutError(error, {
      statusCode: status,
      errorCode: error?.code || error?.errorCode,
    })) {
      const hasKnownRoutingStatus = connection?.routingStatus && connection.routingStatus !== "unknown";
      await syncUsageStatus(connection, {
        routingStatus: hasKnownRoutingStatus ? connection.routingStatus : "eligible",
        healthStatus: "degraded",
        quotaState: connection?.quotaState || "ok",
        authState: connection?.authState || "ok",
        reasonCode: connection?.reasonCode ?? null,
        lastCheckedAt,
        usageSnapshot: JSON.stringify({
          provider: connection?.provider || null,
          checkedAt: lastCheckedAt,
          message: "Usage check temporarily unavailable. Retrying...",
          quotas: {},
        }),
      });
      throw error;
    }

    const quotaSignal = getCodexLiveQuotaSignal(connection, {
      statusCode: status,
      errorText: error?.message || error?.error,
      errorCode: error?.code || error?.errorCode,
    });

    if (quotaSignal) {
      await applyLiveQuotaUpdate(connection, quotaSignal, { observedAt: lastCheckedAt });
    } else {
      await syncUsageStatus(
        connection,
        getConnectionAuthBlockedPatch(error, {
          lastCheckedAt,
          statusCode: status,
          usageSnapshot: JSON.stringify({
            provider: connection?.provider || null,
            checkedAt: lastCheckedAt,
            message: error.reasonDetail || error.message,
          }),
        }) || {
          routingStatus: "blocked",
          healthStatus: "degraded",
          quotaState: "ok",
          authState: "ok",
          reasonCode: isConfirmedAuthBlockedError(error, { statusCode: status }) ? "auth_invalid" : "usage_request_failed",
          reasonDetail: error.reasonDetail || error.message,
          lastCheckedAt,
          ...getOperationalUsageSnapshot(connection, error.reasonDetail || error.message || "Usage check failed.", { checkedAt: lastCheckedAt }),
        }
      );
    }

    throw error;
  }
}

function isAuthExpiredUsageError(error) {
  return isAuthExpiredMessage({
    message: error?.message || error?.error || error?.cause?.message || "",
  });
}
