/**
 * Input record normalization
 */

function toNonArrayObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function pickValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function compactObject(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

const LEGACY_STATUS_FIELDS = new Set([
  "testStatus",
  "test_status",
  "lastTested",
  "last_tested",
  "lastError",
  "last_error",
  "lastErrorAt",
  "last_error_at",
  "lastErrorType",
  "last_error_type",
  "rateLimitedUntil",
  "rate_limited_until",
  "errorCode",
  "error_code",
]);

function findLegacyStatusFields(record = {}) {
  return Object.keys(record).filter((key) => LEGACY_STATUS_FIELDS.has(key));
}

function stripLegacyStatusFields(record = {}) {
  const legacyFields = findLegacyStatusFields(record);
  if (legacyFields.length === 0) return record;

  const cleaned = { ...record };
  for (const field of legacyFields) {
    delete cleaned[field];
  }
  return cleaned;
}

export function normalizeInputRecord(raw) {
  const record = toNonArrayObject(raw);
  if (!record) return null;

  const cleanedRecord = stripLegacyStatusFields(record);

  const credentials = toNonArrayObject(cleanedRecord.credentials);
  const secrets = toNonArrayObject(cleanedRecord.secrets);
  const token = toNonArrayObject(cleanedRecord.token);
  const auth = toNonArrayObject(cleanedRecord.auth);
  const identity = toNonArrayObject(cleanedRecord.identity);
  const meta = toNonArrayObject(cleanedRecord.meta);
  const metadata = toNonArrayObject(cleanedRecord.metadata);

  const providerSpecificData = {
    ...compactObject(cleanedRecord.providerSpecificData),
    ...compactObject(cleanedRecord.provider_specific_data),
  };

  const normalized = {
    id: pickValue(cleanedRecord.id, cleanedRecord.connectionId, cleanedRecord.connection_id),
    provider: pickValue(cleanedRecord.provider, cleanedRecord.providerId, cleanedRecord.provider_id),
    authType: pickValue(
      cleanedRecord.authType,
      cleanedRecord.auth_type,
      auth?.type,
      auth?.authType,
      auth?.auth_type,
    ),
    name: pickValue(cleanedRecord.name, identity?.name, identity?.label),
    displayName: pickValue(cleanedRecord.displayName, cleanedRecord.display_name),
    email: pickValue(cleanedRecord.email, identity?.email),
    priority: pickValue(cleanedRecord.priority),
    isActive: pickValue(cleanedRecord.isActive, cleanedRecord.is_active),
    defaultModel: pickValue(cleanedRecord.defaultModel, cleanedRecord.default_model),
    globalPriority: pickValue(cleanedRecord.globalPriority, cleanedRecord.global_priority),
    accessToken: pickValue(
      cleanedRecord.accessToken,
      cleanedRecord.access_token,
      credentials?.accessToken,
      credentials?.access_token,
      secrets?.accessToken,
      secrets?.access_token,
      token?.accessToken,
      token?.access_token,
    ),
    refreshToken: pickValue(
      cleanedRecord.refreshToken,
      cleanedRecord.refresh_token,
      credentials?.refreshToken,
      credentials?.refresh_token,
      secrets?.refreshToken,
      secrets?.refresh_token,
      token?.refreshToken,
      token?.refresh_token,
    ),
    idToken: pickValue(
      cleanedRecord.idToken,
      cleanedRecord.id_token,
      credentials?.idToken,
      credentials?.id_token,
      secrets?.idToken,
      secrets?.id_token,
      token?.idToken,
      token?.id_token,
    ),
    apiKey: pickValue(
      cleanedRecord.apiKey,
      cleanedRecord.api_key,
      credentials?.apiKey,
      credentials?.api_key,
      secrets?.apiKey,
      secrets?.api_key,
      auth?.apiKey,
      auth?.api_key,
    ),
    expiresAt: pickValue(
      cleanedRecord.expiresAt,
      cleanedRecord.expires_at,
      credentials?.expiresAt,
      credentials?.expires_at,
      secrets?.expiresAt,
      secrets?.expires_at,
      token?.expiresAt,
      token?.expires_at,
    ),
    expiresIn: pickValue(
      cleanedRecord.expiresIn,
      cleanedRecord.expires_in,
      credentials?.expiresIn,
      credentials?.expires_in,
      secrets?.expiresIn,
      secrets?.expires_in,
      token?.expiresIn,
      token?.expires_in,
    ),
    tokenType: pickValue(
      cleanedRecord.tokenType,
      cleanedRecord.token_type,
      credentials?.tokenType,
      credentials?.token_type,
      secrets?.tokenType,
      secrets?.token_type,
      token?.tokenType,
      token?.token_type,
    ),
    scope: pickValue(
      cleanedRecord.scope,
      credentials?.scope,
      secrets?.scope,
      token?.scope,
    ),
    projectId: pickValue(
      cleanedRecord.projectId,
      cleanedRecord.project_id,
      credentials?.projectId,
      credentials?.project_id,
      secrets?.projectId,
      secrets?.project_id,
      metadata?.projectId,
      metadata?.project_id,
      meta?.projectId,
      meta?.project_id,
    ),
    routingStatus: pickValue(cleanedRecord.routingStatus, cleanedRecord.routing_status),
    quotaState: pickValue(cleanedRecord.quotaState, cleanedRecord.quota_state),
    healthStatus: pickValue(cleanedRecord.healthStatus, cleanedRecord.health_status),
    authState: pickValue(cleanedRecord.authState, cleanedRecord.auth_state),
    reasonCode: pickValue(cleanedRecord.reasonCode, cleanedRecord.reason_code),
    reasonDetail: pickValue(cleanedRecord.reasonDetail, cleanedRecord.reason_detail),
    nextRetryAt: pickValue(cleanedRecord.nextRetryAt, cleanedRecord.next_retry_at),
    resetAt: pickValue(cleanedRecord.resetAt, cleanedRecord.reset_at),
    lastCheckedAt: pickValue(cleanedRecord.lastCheckedAt, cleanedRecord.last_checked_at),
    usageSnapshot: pickValue(cleanedRecord.usageSnapshot, cleanedRecord.usage_snapshot),
    version: pickValue(cleanedRecord.version),
    lastUsedAt: pickValue(cleanedRecord.lastUsedAt, cleanedRecord.last_used_at),
    consecutiveUseCount: pickValue(
      cleanedRecord.consecutiveUseCount,
      cleanedRecord.consecutive_use_count,
    ),
    backoffLevel: pickValue(cleanedRecord.backoffLevel, cleanedRecord.backoff_level),
    providerSpecificData: {
      ...providerSpecificData,
      ...compactObject(metadata),
      ...compactObject(meta),
    },
  };

  if (normalized.routingStatus === undefined && normalized.quotaState === "ok") {
    normalized.routingStatus = "eligible";
  }

  if (
    normalized.reasonCode === undefined &&
    normalized.routingStatus === "exhausted"
  ) {
    normalized.reasonCode = "quota_exhausted";
  }

  if (Object.keys(normalized.providerSpecificData).length === 0) {
    delete normalized.providerSpecificData;
  }

  return normalized;
}

export function extractInputRecords(payload) {
  if (Array.isArray(payload)) return payload;

  const obj = toNonArrayObject(payload);
  if (!obj) return null;

  const candidates = [
    obj.credentials,
    obj.entries,
    obj.items,
    obj.connections,
    obj.providerConnections,
    obj.data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return null;
}
