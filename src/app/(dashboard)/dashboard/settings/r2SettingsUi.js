const DEFAULT_R2_CONFIG = {
  accountId: "",
  accessKeyId: "",
  secretAccessKey: "",
  bucket: "",
  endpoint: "",
  region: "",
  publicUrl: "",
  connected: false,
  lastCheckedAt: null,
  lastError: "",
};

const DEFAULT_R2_SETTINGS_RESPONSE = {
  r2Config: DEFAULT_R2_CONFIG,
  r2BackupEnabled: false,
  r2SqliteBackupSchedule: "daily",
  r2AutoPublishEnabled: false,
  r2RuntimePublicBaseUrl: "",
  r2RuntimeCacheTtlSeconds: 15,
  r2LastRuntimePublishAt: null,
  r2LastBackupAt: null,
  r2LastRestoreAt: null,
};

export function sanitizeR2RuntimeCacheTtlSeconds(value, fallback = 15) {
  if (typeof value === "string" && value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  if (parsed < 1) {
    return 1;
  }

  if (parsed > 300) {
    return 300;
  }

  return parsed;
}

export function normalizeR2SettingsResponse(payload = {}) {
  return {
    r2Config: {
      ...DEFAULT_R2_CONFIG,
      ...(payload?.r2Config && typeof payload.r2Config === "object" ? payload.r2Config : {}),
    },
    r2BackupEnabled: payload?.r2BackupEnabled === true,
    r2SqliteBackupSchedule:
      typeof payload?.r2SqliteBackupSchedule === "string" && payload.r2SqliteBackupSchedule
        ? payload.r2SqliteBackupSchedule
        : "daily",
    r2AutoPublishEnabled: payload?.r2AutoPublishEnabled === true,
    r2RuntimePublicBaseUrl:
      typeof payload?.r2RuntimePublicBaseUrl === "string" ? payload.r2RuntimePublicBaseUrl : "",
    r2RuntimeCacheTtlSeconds: sanitizeR2RuntimeCacheTtlSeconds(
      payload?.r2RuntimeCacheTtlSeconds,
      15
    ),
    r2LastRuntimePublishAt:
      typeof payload?.r2LastRuntimePublishAt === "string" ? payload.r2LastRuntimePublishAt : null,
    r2LastBackupAt: typeof payload?.r2LastBackupAt === "string" ? payload.r2LastBackupAt : null,
    r2LastRestoreAt:
      typeof payload?.r2LastRestoreAt === "string" ? payload.r2LastRestoreAt : null,
  };
}

export function buildR2SettingsPayload(state = {}, persistedState = {}) {
  const normalized = normalizeR2SettingsResponse(state);
  const persisted = normalizeR2SettingsResponse(persistedState);
  const payload = {
    r2BackupEnabled: normalized.r2BackupEnabled,
    r2SqliteBackupSchedule: normalized.r2SqliteBackupSchedule,
  };

  if (normalized.r2AutoPublishEnabled !== persisted.r2AutoPublishEnabled) {
    payload.r2AutoPublishEnabled = normalized.r2AutoPublishEnabled;
  }

  if (normalized.r2RuntimePublicBaseUrl !== persisted.r2RuntimePublicBaseUrl) {
    payload.r2RuntimePublicBaseUrl = normalized.r2RuntimePublicBaseUrl;
  }

  if (normalized.r2RuntimeCacheTtlSeconds !== persisted.r2RuntimeCacheTtlSeconds) {
    payload.r2RuntimeCacheTtlSeconds = normalized.r2RuntimeCacheTtlSeconds;
  }

  if (JSON.stringify(normalized.r2Config) !== JSON.stringify(persisted.r2Config)) {
    payload.r2Config = {
      ...normalized.r2Config,
    };
  }

  return payload;
}

export function getDirtyR2Config(config = {}, value, field) {
  return {
    ...normalizeR2SettingsResponse({ r2Config: config }).r2Config,
    [field]: value,
    connected: false,
    lastCheckedAt: null,
    lastError: "",
  };
}

export function hasUnsavedR2Changes(currentSettings = {}, persistedSettings = {}) {
  const current = normalizeR2SettingsResponse(currentSettings);
  const persisted = normalizeR2SettingsResponse(persistedSettings);
  return (
    JSON.stringify(current.r2Config) !== JSON.stringify(persisted.r2Config) ||
    current.r2BackupEnabled !== persisted.r2BackupEnabled ||
    current.r2SqliteBackupSchedule !== persisted.r2SqliteBackupSchedule ||
    current.r2AutoPublishEnabled !== persisted.r2AutoPublishEnabled ||
    current.r2RuntimePublicBaseUrl !== persisted.r2RuntimePublicBaseUrl ||
    current.r2RuntimeCacheTtlSeconds !== persisted.r2RuntimeCacheTtlSeconds
  );
}

export function getR2ConnectionState(config = {}, isTesting = false, isDirty = false) {
  if (isTesting) {
    return {
      tone: "pending",
      label: "Testing connection",
      detail: "Checking the current R2 settings now.",
    };
  }

  const normalized = normalizeR2SettingsResponse({ r2Config: config }).r2Config;
  const requiredFields = [
    normalized.accountId,
    normalized.accessKeyId,
    normalized.secretAccessKey,
    normalized.bucket,
    normalized.endpoint,
    normalized.region,
  ];
  const hasRequiredFields = requiredFields.every((value) => String(value || "").trim() !== "");

  if (!hasRequiredFields) {
    return {
      tone: "idle",
      label: "Not configured",
      detail: "Add the required credentials before testing the connection.",
    };
  }

  if (isDirty) {
    return {
      tone: "ready",
      label: "Unverified changes",
      detail: "Save these edits before running a new connection test.",
    };
  }

  if (normalized.connected) {
    return {
      tone: "success",
      label: "Connected",
      detail: normalized.lastCheckedAt
        ? `Last checked ${formatTimestamp(normalized.lastCheckedAt)}.`
        : "The saved configuration is validated.",
    };
  }

  if (normalized.lastError) {
    return {
      tone: "error",
      label: "Connection failed",
      detail: normalized.lastCheckedAt
        ? `${normalized.lastError} Last checked ${formatTimestamp(normalized.lastCheckedAt)}.`
        : normalized.lastError,
    };
  }

  return {
    tone: "ready",
    label: "Ready to test",
    detail: "Save the latest values if needed, then run a connection test.",
  };
}

export function isPrivateR2Configured(config = {}) {
  const normalized = normalizeR2SettingsResponse({ r2Config: config }).r2Config;
  const requiredFields = [
    normalized.accountId,
    normalized.accessKeyId,
    normalized.secretAccessKey,
    normalized.bucket,
    normalized.endpoint,
    normalized.region,
  ];

  return requiredFields.every((value) => String(value || "").trim() !== "");
}

export function isPrivateR2Ready(config = {}, isDirty = false) {
  const normalized = normalizeR2SettingsResponse({ r2Config: config }).r2Config;
  return isPrivateR2Configured(normalized) && normalized.connected === true && !isDirty;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "recently";
  }

  return date.toLocaleString();
}

export { DEFAULT_R2_CONFIG, DEFAULT_R2_SETTINGS_RESPONSE };
