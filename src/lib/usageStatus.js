import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { saveRequestDetail, saveRequestUsage } from "@/lib/usageDb";
import { writeConnectionHotState } from "@/lib/providerHotState";

const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
const AUTH_BLOCKED_PATTERNS = [
  "token invalid",
  "invalid token",
  "token expired",
  "refresh failed",
  "re-authorize",
  "reauthorize",
  "sign in again",
  "unauthorized",
  "unauthenticated",
  "revoked",
  "invalid grant",
  "invalid_client",
  "invalid_token",
  "oauth",
  "access token",
  "authentication",
];
const CODEX_LIVE_QUOTA_PATTERNS = [
  "exceeded your current quota",
  "quota exceeded",
  "quota exhausted",
  "insufficient quota",
  "billing hard limit",
  "hard limit reached",
  "usage_limit_reached",
  "usage limit reached",
  "usage limit has been reached",
  "weekly quota exhausted",
];
const UPSTREAM_PROCESSING_ERROR_PATTERNS = [
  "error occurred",
  "request id",
  "internal error",
];

const TRANSIENT_UPSTREAM_TIMEOUT_PATTERNS = [
  "upstream timed out after",
  "stream idle timed out after",
];

export function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

const LEGACY_MIRROR_FIELDS = new Set([
  "testStatus",
  "lastTested",
  "lastErrorType",
  "lastErrorAt",
  "rateLimitedUntil",
  "errorCode",
  "lastError",
]);

function stripLegacyMirrorFields(updates = {}) {
  if (!updates || typeof updates !== "object") return {};

  const sanitized = { ...updates };
  for (const key of LEGACY_MIRROR_FIELDS) {
    delete sanitized[key];
  }

  return sanitized;
}

function parseSnapshot(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildCodexSyntheticSnapshot(connection = {}, snapshot = {}, { checkedAt = new Date().toISOString() } = {}) {
  const previousSnapshot = parseSnapshot(connection?.usageSnapshot);
  const reasonDetail = snapshot?.message || connection?.reasonDetail || null;
  const quotas = snapshot?.quotas && typeof snapshot.quotas === "object"
    ? snapshot.quotas
    : (previousSnapshot?.quotas && typeof previousSnapshot.quotas === "object" ? previousSnapshot.quotas : {});

  const nextSnapshot = {
    provider: connection?.provider || "codex",
    checkedAt,
    ...previousSnapshot,
    ...snapshot,
    quotas,
  };

  if (!nextSnapshot.message && reasonDetail) {
    nextSnapshot.message = reasonDetail;
  }
  if (!nextSnapshot.resetAt && (snapshot?.resetAt || connection?.resetAt)) {
    nextSnapshot.resetAt = snapshot?.resetAt || connection?.resetAt;
  }
  if (!nextSnapshot.nextRetryAt && (snapshot?.nextRetryAt || connection?.nextRetryAt)) {
    nextSnapshot.nextRetryAt = snapshot?.nextRetryAt || connection?.nextRetryAt;
  }

  return nextSnapshot;
}

function ensureUsageSnapshot(connection, updates = {}, { checkedAt } = {}) {
  if (updates?.usageSnapshot !== undefined && updates?.usageSnapshot !== null) {
    return updates;
  }

  // Build synthetic snapshot for ALL providers, not just Codex
  const syntheticSnapshot = {
    provider: connection?.provider || null,
    checkedAt: checkedAt || new Date().toISOString(),
    message: updates?.reasonDetail || updates?.reasonCode || "Status updated",
    routingStatus: updates?.routingStatus || null,
    quotaState: updates?.quotaState || null,
    authState: updates?.authState || null,
    healthStatus: updates?.healthStatus || null,
    ...(updates?.resetAt ? { resetAt: updates.resetAt } : {}),
    ...(updates?.nextRetryAt ? { nextRetryAt: updates.nextRetryAt } : {}),
  };

  // For Codex, use the richer synthetic snapshot
  if (connection?.provider === "codex") {
    const codexSnapshot = buildCodexSyntheticSnapshot(connection, {
      message: updates?.reasonDetail || null,
      resetAt: updates?.resetAt || null,
      nextRetryAt: updates?.nextRetryAt || null,
    }, { checkedAt });

    return {
      ...updates,
      usageSnapshot: JSON.stringify(codexSnapshot),
    };
  }

  return {
    ...updates,
    usageSnapshot: JSON.stringify(syntheticSnapshot),
  };
}

export async function syncUsageStatus(connection, updates) {
  if (!connection?.id || !updates || typeof updates !== "object") {
    return;
  }

  // Prevent stale updates from overwriting fresh data
  const currentConnection = await getProviderConnectionById(connection.id);
  if (currentConnection?.lastCheckedAt && updates?.lastCheckedAt) {
    const currentCheckedAt = new Date(currentConnection.lastCheckedAt).getTime();
    const newCheckedAt = new Date(updates.lastCheckedAt).getTime();

    if (currentCheckedAt > newCheckedAt) {
      console.warn(`[UsageStatus] Ignoring stale update for ${connection.id}: current=${currentConnection.lastCheckedAt}, new=${updates.lastCheckedAt}`);
      return;
    }
  }

  const sanitizedUpdates = stripLegacyMirrorFields(updates);
  const allowAuthRecovery = sanitizedUpdates.allowAuthRecovery === true;
  if ("allowAuthRecovery" in sanitizedUpdates) {
    delete sanitizedUpdates.allowAuthRecovery;
  }
  const isRecoveryToEligible = sanitizedUpdates.routingStatus === "eligible"
    && sanitizedUpdates.authState === "ok";
  const hasAuthInvalidBlock = connection?.reasonCode === "auth_invalid"
    || connection?.authState === "invalid"
    || connection?.routingStatus === "blocked";

  if (isRecoveryToEligible && hasAuthInvalidBlock && !allowAuthRecovery) {
    return stripLegacyMirrorFields({
      ...connection,
      ...sanitizedUpdates,
      routingStatus: connection?.routingStatus,
      authState: connection?.authState,
      reasonCode: connection?.reasonCode,
      reasonDetail: connection?.reasonDetail,
      nextRetryAt: connection?.nextRetryAt ?? sanitizedUpdates.nextRetryAt ?? null,
      resetAt: connection?.resetAt ?? sanitizedUpdates.resetAt ?? null,
    });
  }

  const lastCheckedAt = sanitizedUpdates.lastCheckedAt || updates.lastCheckedAt || updates.lastTested || new Date().toISOString();
  const hotPatch = {
    ...ensureUsageSnapshot(connection, sanitizedUpdates, { checkedAt: lastCheckedAt }),
    lastCheckedAt,
    version: sanitizedUpdates.version || updates.version || Date.now(),
  };
  const snapshot = await writeConnectionHotState({
    connectionId: connection.id,
    provider: connection.provider,
    patch: hotPatch,
  });
  const merged = stripLegacyMirrorFields(snapshot || hotPatch);

  return merged;
}

function getHealthyUsageStatusUpdates(usage) {
  const lastCheckedAt = new Date().toISOString();
  return {
    routingStatus: "eligible",
    healthStatus: "healthy",
    quotaState: "ok",
    authState: "ok",
    reasonCode: null,
    reasonDetail: null,
    lastCheckedAt,
    usageSnapshot: JSON.stringify(usage || {}),
    resetAt: null,
    nextRetryAt: null,
  };
}

export function getConnectionRecoveryPatch({ lastCheckedAt = new Date().toISOString(), usageSnapshot = undefined } = {}) {
  return {
    routingStatus: "eligible",
    healthStatus: "healthy",
    quotaState: "ok",
    authState: "ok",
    reasonCode: null,
    reasonDetail: null,
    nextRetryAt: null,
    resetAt: null,
    backoffLevel: 0,
    lastCheckedAt,
    ...(usageSnapshot !== undefined ? { usageSnapshot } : {}),
  };
}

export function getLiveRequestRecoveryPatch({ lastCheckedAt = new Date().toISOString(), usageSnapshot = undefined } = {}) {
  return {
    ...getConnectionRecoveryPatch({ lastCheckedAt, usageSnapshot }),
    allowAuthRecovery: true,
  };
}

export function isConfirmedAuthBlockedError(error, { statusCode = null } = {}) {
  if (statusCode === 401) {
    return true;
  }

  const message = typeof error === "string"
    ? error
    : error?.message || error?.error || error?.cause?.message || "";

  if (!message) {
    return false;
  }

  const normalized = String(message).toLowerCase();
  const hasAuthEvidence = AUTH_BLOCKED_PATTERNS.some((pattern) => normalized.includes(pattern));

  if (statusCode === 403) {
    return hasAuthEvidence;
  }

  return hasAuthEvidence;
}

export function getConnectionAuthBlockedPatch(error, { lastCheckedAt = new Date().toISOString(), statusCode = null, usageSnapshot = undefined } = {}) {
  const message = typeof error === "string"
    ? error
    : error?.message || error?.error || error?.cause?.message || "";

  if (!isConfirmedAuthBlockedError(message, { statusCode })) {
    return null;
  }

  const reasonDetail = message || "Provider error";
  const normalizedReason = reasonDetail.toLowerCase();
  const requiresReauthorization = normalizedReason.includes("re-authorize")
    || normalizedReason.includes("reauthorize")
    || normalizedReason.includes("invalid grant")
    || normalizedReason.includes("revoked");

  return {
    routingStatus: requiresReauthorization ? "disabled" : "blocked",
    healthStatus: "healthy",
    quotaState: "ok",
    authState: "invalid",
    reasonCode: requiresReauthorization ? "reauthorization_required" : "auth_invalid",
    reasonDetail,
    nextRetryAt: null,
    resetAt: null,
    lastCheckedAt,
    ...(usageSnapshot !== undefined ? { usageSnapshot } : {}),
  };
}

export function isUpstreamProcessingError(statusCode, errorMessage) {
  if (!Number.isFinite(Number(statusCode))) {
    return false;
  }

  const numericStatusCode = Number(statusCode);
  if (numericStatusCode < 500 || numericStatusCode > 599) {
    return false;
  }

  const message = typeof errorMessage === "string"
    ? errorMessage
    : errorMessage?.message || errorMessage?.error || errorMessage?.cause?.message || "";

  if (!message) {
    return false;
  }

  const normalized = String(message).toLowerCase();
  return UPSTREAM_PROCESSING_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function isTransientUpstreamTimeoutError(error, { statusCode = null, errorCode = null } = {}) {
  const message = typeof error === "string"
    ? error
    : error?.message || error?.error || error?.cause?.message || "";

  const normalizedMessage = String(message || "").toLowerCase();
  const normalizedErrorCode = String(errorCode || error?.code || "").toUpperCase();
  const numericStatusCode = Number.isFinite(Number(statusCode)) ? Number(statusCode) : null;

  if (normalizedErrorCode === "UPSTREAM_TIMEOUT" || normalizedErrorCode === "STREAM_IDLE_TIMEOUT") {
    return true;
  }

  if (numericStatusCode !== null && numericStatusCode !== 504) {
    return false;
  }

  return TRANSIENT_UPSTREAM_TIMEOUT_PATTERNS.some((pattern) => normalizedMessage.includes(pattern));
}

export function getCodexLiveQuotaSignal(connection, { statusCode, errorText, errorCode } = {}) {
  if (connection?.provider !== "codex") return null;
  if (statusCode !== 429) return null;

  let parsedErrorType = "";
  let parsedResetAt = null;
  if (typeof errorText === "string") {
    try {
      const parsed = JSON.parse(errorText);
      parsedErrorType = parsed?.error?.type || parsed?.type || parsed?.code || "";
      parsedResetAt = parsed?.error?.resets_at || parsed?.error?.reset_at || parsed?.resets_at || parsed?.reset_at || null;
    } catch {
      parsedErrorType = "";
    }
  }

  const normalized = [errorText, errorCode, parsedErrorType]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(" ");

  if (!normalized || !CODEX_LIVE_QUOTA_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return null;
  }

  const numericReset = Number(parsedResetAt);
  const parsedResetTimestamp = Number.isFinite(numericReset)
    ? (numericReset < 1000000000000 ? numericReset * 1000 : numericReset)
    : parsedResetAt
      ? new Date(parsedResetAt).getTime()
      : null;

  return {
    provider: "codex",
    kind: "quota_exhausted",
    reasonCode: "quota_exhausted",
    reasonDetail: "Codex quota exhausted",
    errorCode: "codex_live_quota_exhausted",
    resetAt: Number.isFinite(parsedResetTimestamp) ? new Date(parsedResetTimestamp).toISOString() : null,
  };
}

function getCodexExhaustedQuota(usage = {}) {
  const quotas = usage?.quotas;
  if (!quotas || typeof quotas !== "object") return null;

  for (const [quotaName, quota] of Object.entries(quotas)) {
    if (!quota || typeof quota !== "object") continue;

    const remaining = getFiniteNumber(quota.remaining);
    const used = getFiniteNumber(quota.used);
    const total = getFiniteNumber(quota.total);

    const hasExhaustedRemaining = remaining !== null && remaining <= 0;
    const hasExhaustedTotal = total !== null
      && total > 0
      && used !== null
      && used >= total;

    if (hasExhaustedRemaining || hasExhaustedTotal) {
      return {
        quotaName,
        resetAt: quota.resetAt || null,
      };
    }
  }

  return null;
}

function getConfiguredMinimumRemainingQuotaPercent(connection = {}, options = {}) {
  const explicitOptionThreshold = options?.globalExhaustedThreshold;
  if (explicitOptionThreshold !== undefined && explicitOptionThreshold !== null && explicitOptionThreshold !== "") {
    const parsed = Number(explicitOptionThreshold);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(100, parsed));
    }
  }

  const rawValue = connection?.providerSpecificData?.minimumRemainingQuotaPercent;
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return 10;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return 10;

  return Math.max(0, Math.min(100, parsed));
}

function getFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getSafeRemainingPercent(quota = {}) {
  if (!quota || typeof quota !== "object") return null;

  const explicitRemainingPercentage = getFiniteNumber(quota.remainingPercentage);
  if (explicitRemainingPercentage !== null && explicitRemainingPercentage >= 0 && explicitRemainingPercentage <= 100) {
    return explicitRemainingPercentage;
  }

  const total = getFiniteNumber(quota.total);
  const used = getFiniteNumber(quota.used);
  const remaining = getFiniteNumber(quota.remaining);

  if (total !== null && total > 0 && remaining !== null && remaining >= 0 && remaining <= total) {
    const remainingPercent = (remaining / total) * 100;
    return Number.isFinite(remainingPercent) && remainingPercent >= 0 && remainingPercent <= 100
      ? remainingPercent
      : null;
  }

  if (total === null || total <= 0) return null;
  if (used === null || used < 0) return null;

  const remainingPercent = ((total - used) / total) * 100;
  if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
    return null;
  }

  return remainingPercent;
}

function getKiroQuotaSignal(connection, usage = {}, options = {}) {
  const quotas = usage?.quotas;
  if (!quotas || typeof quotas !== "object") {
    if (usage?.limitReached === true || usage?.revoked === true) {
      return {
        kind: "exhausted",
        quotaName: null,
        resetAt: null,
      };
    }
    return null;
  }

  const minimumRemainingQuotaPercent = getConfiguredMinimumRemainingQuotaPercent(connection, options);

  for (const [quotaName, quota] of Object.entries(quotas)) {
    if (!quota || typeof quota !== "object") continue;

    const total = quota.total;
    const used = quota.used;
    const remaining = quota.remaining;

    const hasExplicitExhaustion = typeof remaining === "number" && remaining <= 0;
    const hasUsedAllQuota = Number.isFinite(total)
      && total > 0
      && Number.isFinite(used)
      && used >= total;

    if (hasExplicitExhaustion || hasUsedAllQuota || usage?.limitReached === true || usage?.revoked === true) {
      return {
        kind: "exhausted",
        quotaName,
        resetAt: quota.resetAt || null,
      };
    }

    const remainingPercent = getSafeRemainingPercent(quota);
    if (remainingPercent === null) continue;

    if (remainingPercent <= minimumRemainingQuotaPercent) {
      return {
        kind: "threshold",
        quotaName,
        resetAt: quota.resetAt || null,
        remainingPercent,
        minimumRemainingQuotaPercent,
      };
    }
  }

  if (usage?.limitReached === true || usage?.revoked === true) {
    return {
      kind: "exhausted",
      quotaName: null,
      resetAt: null,
    };
  }

  return null;
}

export function getUsageStatusUpdates(connection, usage, options = {}) {
  const base = getHealthyUsageStatusUpdates(usage);
  const liveSignal = options.liveSignal || null;
  const nowIso = options.observedAt || new Date().toISOString();
  const usageMessage = typeof usage?.message === "string" ? usage.message : "";

  const codexUsageApiUnavailableMatch = connection?.provider === "codex"
    ? usageMessage.match(/^Codex connected\. Usage API temporarily unavailable \((\d{3})\)\.?$/)
    : null;

  if (codexUsageApiUnavailableMatch) {
    return {
      ...base,
      routingStatus: "eligible",
      healthStatus: "degraded",
      quotaState: "ok",
      authState: "ok",
      reasonCode: "usage_request_failed",
      reasonDetail: usageMessage,
      usageSnapshot: JSON.stringify(usage || {}),
      resetAt: null,
      nextRetryAt: null,
      lastCheckedAt: nowIso,
    };
  }

  const authBlockedPatch = getConnectionAuthBlockedPatch(usageMessage, {
    lastCheckedAt: nowIso,
    statusCode: connection?.provider === "codex" && /\((\d{3})\)/.test(usageMessage)
      ? Number(usageMessage.match(/\((\d{3})\)/)?.[1])
      : null,
  });

  if (authBlockedPatch) {
    return {
      ...base,
      ...authBlockedPatch,
      usageSnapshot: JSON.stringify(usage || {}),
    };
  }

  if (liveSignal?.kind === "quota_exhausted" && connection?.provider === "codex") {
    return {
      ...base,
      routingStatus: "exhausted",
      healthStatus: "degraded",
      quotaState: "exhausted",
      reasonCode: liveSignal.reasonCode || "quota_exhausted",
      reasonDetail: liveSignal.reasonDetail || "Codex quota exhausted",
      resetAt: liveSignal.resetAt || null,
      nextRetryAt: liveSignal.resetAt || null,
      usageSnapshot: JSON.stringify(buildCodexSyntheticSnapshot(connection, {
        message: liveSignal.reasonDetail || "Codex quota exhausted",
        resetAt: liveSignal.resetAt || null,
        nextRetryAt: liveSignal.resetAt || null,
      }, { checkedAt: nowIso })),
    };
  }

  if (connection?.provider !== "codex") {
    if (connection?.provider === "kiro") {
      const kiroQuotaSignal = getKiroQuotaSignal(connection, usage, options);

      if (kiroQuotaSignal?.kind === "exhausted") {
        return {
          ...base,
          routingStatus: "exhausted",
          healthStatus: "degraded",
          quotaState: "exhausted",
          reasonCode: "quota_exhausted",
          reasonDetail: "Kiro quota exhausted",
          resetAt: kiroQuotaSignal.resetAt || null,
          nextRetryAt: kiroQuotaSignal.resetAt || null,
          usageSnapshot: JSON.stringify(usage || {}),
        };
      }

      if (kiroQuotaSignal?.kind === "threshold") {
        return {
          ...base,
          routingStatus: "exhausted",
          healthStatus: "degraded",
          quotaState: "exhausted",
          reasonCode: "quota_threshold",
          reasonDetail: `Kiro remaining quota is at or below ${kiroQuotaSignal.minimumRemainingQuotaPercent}%`,
          resetAt: kiroQuotaSignal.resetAt || null,
          nextRetryAt: kiroQuotaSignal.resetAt || null,
          usageSnapshot: JSON.stringify(usage || {}),
        };
      }
    }

    return base;
  }

  const exhaustedQuota = getCodexExhaustedQuota(usage);

  if (exhaustedQuota || usage?.limitReached === true) {
    const quotaLabel = exhaustedQuota?.quotaName === "session"
      ? "session"
      : exhaustedQuota?.quotaName === "weekly"
        ? "weekly"
        : "quota";
    const reasonDetail = quotaLabel === "quota"
      ? "Codex quota exhausted"
      : `Codex ${quotaLabel} quota exhausted`;
    return {
      ...base,
      routingStatus: "exhausted",
      healthStatus: "degraded",
      quotaState: "exhausted",
      reasonCode: "quota_exhausted",
      reasonDetail,
      resetAt: exhaustedQuota?.resetAt || null,
      nextRetryAt: exhaustedQuota?.resetAt || null,
      usageSnapshot: JSON.stringify(usage || {}),
    };
  }

  const thresholds = Object.values(usage?.quotas || {});
  const minimumRemainingQuotaPercent = getConfiguredMinimumRemainingQuotaPercent(connection, options);
  const thresholdQuota = thresholds.find((quota) => {
    if (!quota || typeof quota !== "object") return false;
    const remainingPercent = getSafeRemainingPercent(quota);
    if (remainingPercent === null) return false;
    return remainingPercent <= minimumRemainingQuotaPercent;
  });

  if (thresholdQuota) {
    return {
      ...base,
      routingStatus: "exhausted",
      healthStatus: "degraded",
      quotaState: "exhausted",
      reasonCode: "quota_threshold",
      reasonDetail: `Remaining quota is at or below ${minimumRemainingQuotaPercent}%`,
      resetAt: thresholdQuota.resetAt || null,
      nextRetryAt: thresholdQuota.resetAt || null,
      usageSnapshot: JSON.stringify(usage || {}),
    };
  }

  return base;
}

export async function applyCanonicalUsageRefresh(connection, usage, options = {}) {
  const updates = getUsageStatusUpdates(connection, usage, options);
  await syncUsageStatus(connection, updates);
  return updates;
}

export async function applyLiveQuotaUpdate(connection, signal, options = {}) {
  if (!connection?.id || !signal) return null;
  const updates = getUsageStatusUpdates(connection, null, {
    ...options,
    liveSignal: signal,
  });
  await syncUsageStatus(connection, updates);
  return updates;
}

function normalizeReportTokens(report = {}) {
  const usage = report.usage;
  if (!usage || typeof usage !== "object") return null;

  const promptTokens = Number(
    usage.prompt_tokens
    ?? usage.input_tokens
    ?? usage.promptTokens
    ?? usage.inputTokens
    ?? 0
  );
  const completionTokens = Number(
    usage.completion_tokens
    ?? usage.output_tokens
    ?? usage.completionTokens
    ?? usage.outputTokens
    ?? 0
  );
  const cachedTokens = Number(usage.cached_tokens ?? usage.cachedTokens ?? usage.cache_read_input_tokens ?? 0);

  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(cachedTokens)) {
    return null;
  }

  if (promptTokens <= 0 && completionTokens <= 0 && cachedTokens <= 0) {
    return null;
  }

  return {
    prompt_tokens: Math.max(0, Math.trunc(promptTokens)),
    completion_tokens: Math.max(0, Math.trunc(completionTokens)),
    ...(cachedTokens > 0 ? { cached_tokens: Math.max(0, Math.trunc(cachedTokens)) } : {}),
  };
}

function mapReportStatus(report = {}) {
  const outcome = String(report.outcome || "").toLowerCase();
  if (outcome === "error" || outcome === "failed" || outcome === "failure") {
    return "error";
  }

  const upstreamStatus = Number(report.upstreamStatus);
  if (Number.isFinite(upstreamStatus) && upstreamStatus >= 400) {
    return "error";
  }

  if (report.error) {
    return "error";
  }

  return "ok";
}

function getReportObservedAt(report = {}) {
  return report.observedAt || report.finishedAt || report.timestamp || new Date().toISOString();
}

export async function applyProxyOutcomeReport(report = {}) {
  const connectionId = report.connectionId || null;
  const provider = report.provider || null;
  const model = report.model || report.requestedModel || null;
  const observedAt = getReportObservedAt(report);
  const status = mapReportStatus(report);
  const tokens = normalizeReportTokens(report);
  const usageEvidence = report.usage && typeof report.usage === "object"
    ? report.usage
    : null;
  const quotasEvidence = report.quotas && typeof report.quotas === "object"
    ? report.quotas
    : null;
  const hasCanonicalUsageEvidence = Boolean(tokens || usageEvidence || quotasEvidence);

  if (tokens) {
    await saveRequestUsage({
      provider,
      model,
      tokens,
      connectionId,
      endpoint: report.publicPath || report.route || null,
      status,
      timestamp: observedAt,
    }, { propagateError: true });
  }

  await saveRequestDetail({
    id: report.requestId || report.id || undefined,
    provider,
    model,
    connectionId,
    timestamp: observedAt,
    status,
    latency: {
      totalMs: report.latencyMs ?? null,
    },
    tokens: tokens || {},
    request: {
      protocolFamily: report.protocolFamily || null,
      publicPath: report.publicPath || null,
      method: report.method || null,
    },
    providerRequest: {
      requestId: report.requestId || null,
    },
    providerResponse: {
      status: report.upstreamStatus ?? null,
      error: report.error || null,
    },
    response: {
      outcome: report.outcome || null,
    },
  }, { forceFlush: false, propagateError: true });

  if (!connectionId) {
    return { ok: true };
  }

  const connection = await getProviderConnectionById(connectionId);
  if (!connection) {
    return { ok: true };
  }

  const statusCode = Number.isFinite(Number(report.upstreamStatus))
    ? Number(report.upstreamStatus)
    : null;
  const errorMessage = report.error?.message || report.error || null;

  if (status === "error") {
    if (isTransientUpstreamTimeoutError(report.error, {
      statusCode,
      errorCode: report.error?.code,
    })) {
      await syncUsageStatus(connection, {
        lastCheckedAt: observedAt,
        lastError: null,
        lastErrorType: null,
        lastErrorAt: null,
        errorCode: null,
      });
      return { ok: true };
    }

    // Generic upstream processing failures are operational noise and should not
    // become persisted account status.
    if (isUpstreamProcessingError(statusCode, errorMessage)) {
      await syncUsageStatus(connection, {
        lastCheckedAt: observedAt,
      });
      return { ok: true };
    }

    const authPatch = getConnectionAuthBlockedPatch(errorMessage, {
      lastCheckedAt: observedAt,
      statusCode,
    });

    if (authPatch) {
      await syncUsageStatus(connection, authPatch);
      return { ok: true };
    }

    const liveSignal = getCodexLiveQuotaSignal(connection, {
      statusCode,
      errorText: errorMessage,
      errorCode: report.error?.code,
    });

    if (liveSignal) {
      await applyLiveQuotaUpdate(connection, liveSignal, { observedAt });
      return { ok: true };
    }

    await syncUsageStatus(connection, {
      healthStatus: "degraded",
      lastCheckedAt: observedAt,
      lastError: errorMessage || "Proxy request failed",
      lastErrorType: "proxy_error",
      lastErrorAt: observedAt,
      errorCode: report.error?.code || "proxy_error",
    });

    return { ok: true };
  }

  if (hasCanonicalUsageEvidence) {
    await applyCanonicalUsageRefresh(connection, {
      quotas: quotasEvidence,
      usage: usageEvidence,
    }, { observedAt });
    return { ok: true };
  }

  await syncUsageStatus(connection, {
    lastCheckedAt: observedAt,
    usageSnapshot: JSON.stringify(usageEvidence || {}),
  });

  return { ok: true };
}
