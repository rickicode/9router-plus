import fs from "node:fs";
import crypto from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import {
  exportDb,
  getSettings,
  prepareLocalDbForExternalRestore,
  reloadLocalDbAfterExternalRestore,
  updateSettings,
} from "./localDb.js";
import { DB_SQLITE_FILE } from "./sqliteHelpers.js";
import {
  R2_FULL_CREDENTIALS_OBJECT_KEY,
  R2_RUNTIME_CONFIG_OBJECT_KEY,
  buildBackupArtifact,
  buildRuntimeArtifact,
  buildEligibleRuntimeArtifact,
  buildFullCredentialsArtifact,
  buildRuntimeConfigArtifact,
} from "./r2RuntimeArtifacts.js";
import { buildR2BucketProbeUrl, buildR2ObjectUrl, putObjectWithRetry, signR2Request } from "./r2ObjectClient.js";
import { computeSqliteFingerprint, hasSqliteChanged } from "./r2SqliteFingerprint.js";

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BACKUP_PREFIX = "private/backups";
const ENCRYPTED_BACKUP_FORMAT = "9router-r2-encrypted-backup-v1";
const ENCRYPTED_SQLITE_FORMAT = "9router-r2-encrypted-sqlite-v1";
const BACKUP_ENCRYPTION_KEY_ID = "local-r2-backup-key-v1";

function buildArtifactUrls(baseUrl) {
  const normalizedBaseUrl = normalizeUrl(baseUrl);

  if (!normalizedBaseUrl) {
    throw new Error("Missing R2 runtime public base URL");
  }

  return {
    backupUrl: `${normalizedBaseUrl}/backup.json`,
    runtimeUrl: `${normalizedBaseUrl}/runtime.json`,
    eligibleUrl: `${normalizedBaseUrl}/eligible.json`,
    sqliteUrl: `${normalizedBaseUrl}/sqlite/latest.db`,
  };
}

function normalizeObjectPrefix(prefix, fallback = "") {
  const normalized = String(prefix || fallback || "").trim().replace(/^\/+|\/+$/g, "");
  return normalized ? `${normalized}/` : "";
}

function buildBackupObjectKey(settingsOrConfig = {}, fileName = "backup.json") {
  return `${normalizeObjectPrefix(settingsOrConfig?.r2BackupPrefix, DEFAULT_BACKUP_PREFIX)}${fileName}`;
}

function buildSqliteObjectKey(settingsOrConfig = {}, fileName = "latest.db") {
  return `${normalizeObjectPrefix(settingsOrConfig?.r2BackupPrefix, DEFAULT_BACKUP_PREFIX)}sqlite/${fileName}`;
}

function buildRuntimeObjectKey(settingsOrConfig = {}) {
  const runtimeBaseUrl = String(settingsOrConfig?.r2RuntimePublicBaseUrl || "").trim();

  if (!runtimeBaseUrl) return "runtime.json";

  try {
    const { pathname } = new URL(runtimeBaseUrl);
    const prefix = pathname.replace(/^\/+|\/+$/g, "");

    if (!prefix) {
      throw new Error("Runtime public base URL must include a path prefix");
    }

    return `${prefix}/runtime.json`;
  } catch (error) {
    if (error.message === "Runtime public base URL must include a path prefix") {
      throw error;
    }
    throw new Error(`Invalid runtime public base URL: ${error.message}`);
  }
}

function buildEligibleObjectKey(settingsOrConfig = {}) {
  return buildRuntimeObjectKey(settingsOrConfig).replace(/runtime\.json$/, "eligible.json");
}

function buildArtifactWriteUrls(settingsOrConfig) {
  const config = settingsOrConfig?.r2Config || settingsOrConfig;
  return {
    backupUrl: buildR2ObjectUrl(config, buildBackupObjectKey(settingsOrConfig)),
    runtimeUrl: buildR2ObjectUrl(config, buildRuntimeObjectKey(settingsOrConfig)),
    eligibleUrl: buildR2ObjectUrl(config, buildEligibleObjectKey(settingsOrConfig)),
    fullRuntimeUrl: buildR2ObjectUrl(config, R2_FULL_CREDENTIALS_OBJECT_KEY),
    runtimeConfigUrl: buildR2ObjectUrl(config, R2_RUNTIME_CONFIG_OBJECT_KEY),
    sqliteUrl: buildR2ObjectUrl(config, buildSqliteObjectKey(settingsOrConfig)),
  };
}

async function readJsonArtifact(artifactUrl, fetchImpl = fetch) {
  const response = await fetchImpl(artifactUrl, {
    method: "GET",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch R2 artifact ${artifactUrl}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function readSignedJsonArtifact(config, objectKey, fetchImpl = fetch) {
  if (!config?.endpoint || !config?.bucket || !config?.accessKeyId || !config?.secretAccessKey) {
    throw new Error("Missing R2 configuration for private backup artifact read");
  }

  const artifactUrl = buildR2ObjectUrl(config, objectKey);
  const signedRequest = signR2Request({
    method: "GET",
    url: artifactUrl,
    r2Config: config,
  });
  const artifact = await readJsonArtifactWithOptions(artifactUrl, {
    method: "GET",
    headers: signedRequest,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, fetchImpl);

  return { artifactUrl, artifact };
}

async function readJsonArtifactWithOptions(artifactUrl, options, fetchImpl = fetch) {
  const response = await fetchImpl(artifactUrl, options);

  if (!response.ok) {
    throw new Error(`Failed to fetch R2 artifact ${artifactUrl}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function readBinaryArtifact(artifactUrl, fetchImpl = fetch) {
  const response = await fetchImpl(artifactUrl, {
    method: "GET",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch R2 artifact ${artifactUrl}: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function readSignedBinaryArtifact(config, objectKey, fetchImpl = fetch) {
  if (!config?.endpoint || !config?.bucket || !config?.accessKeyId || !config?.secretAccessKey) {
    throw new Error("Missing R2 configuration for private backup artifact read");
  }

  const artifactUrl = buildR2ObjectUrl(config, objectKey);
  const signedRequest = signR2Request({
    method: "GET",
    url: artifactUrl,
    r2Config: config,
  });
  const response = await fetchImpl(artifactUrl, {
    method: "GET",
    headers: signedRequest,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch R2 artifact ${artifactUrl}: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function createUploadResult(uploadResult) {
  return {
    ok: uploadResult?.ok === true,
    uploaded: uploadResult?.ok === true,
    skipped: false,
    attempts: Number(uploadResult?.attempts) || 0,
  };
}

function createUploadFailureResult(error) {
  return {
    ok: false,
    uploaded: false,
    skipped: false,
    attempts: 0,
    error: error?.message || "Unknown upload failure",
  };
}

function deriveBackupEncryptionKey(settings = {}) {
  const keyMaterial = settings?.r2BackupEncryptionKey;
  if (!keyMaterial) {
    throw new Error("Missing R2 backup encryption key");
  }

  return crypto.createHash("sha256").update(String(keyMaterial)).digest();
}

function ensureBackupEncryptionKey(settings = {}) {
  return typeof settings?.r2BackupEncryptionKey === "string" && settings.r2BackupEncryptionKey
    ? settings.r2BackupEncryptionKey
    : crypto.randomBytes(32).toString("hex");
}

function encryptBuffer(buffer, settings = {}) {
  const key = deriveBackupEncryptionKey(settings);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);

  return {
    alg: "aes-256-gcm",
    keyId: BACKUP_ENCRYPTION_KEY_ID,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptEnvelopePayload(payload, settings = {}) {
  if (payload?.alg !== "aes-256-gcm" || !payload?.iv || !payload?.tag || !payload?.data) {
    throw new Error("Invalid encrypted R2 backup payload");
  }
  if (payload.keyId && payload.keyId !== BACKUP_ENCRYPTION_KEY_ID) {
    throw new Error("Unsupported R2 backup encryption key");
  }

  const key = deriveBackupEncryptionKey(settings);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);
}

function buildEncryptedBackupArtifact(snapshot, settings = {}, sqliteState = null) {
  const backupKey = buildBackupObjectKey(settings);
  const sqliteKey = buildSqliteObjectKey(settings);
  const backupBuffer = Buffer.from(JSON.stringify(snapshot || {}), "utf8");
  const sqliteSize = sqliteState?.data ? Buffer.byteLength(sqliteState.data) : 0;

  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    encrypted: true,
    generatedAt: new Date().toISOString(),
    machineId: snapshot?.machineId || snapshot?.meta?.machineId || null,
    key: backupKey,
    sqlite: {
      key: sqliteKey,
      encrypted: true,
      size: sqliteSize,
      fingerprint: sqliteState?.fingerprint || null,
    },
    payload: encryptBuffer(backupBuffer, settings),
  };
}

function buildEncryptedSqliteEnvelope(sqliteData, settings = {}) {
  const sqliteBuffer = Buffer.isBuffer(sqliteData) ? sqliteData : Buffer.from(sqliteData || "");
  return Buffer.from(JSON.stringify({
    format: ENCRYPTED_SQLITE_FORMAT,
    encrypted: true,
    generatedAt: new Date().toISOString(),
    payload: encryptBuffer(sqliteBuffer, settings),
  }), "utf8");
}

function decryptSqliteEnvelope(buffer, settings = {}) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(buffer).toString("utf8"));
  } catch {
    return Buffer.from(buffer);
  }

  if (envelope?.format !== ENCRYPTED_SQLITE_FORMAT || envelope.encrypted !== true) {
    return Buffer.from(buffer);
  }

  return decryptEnvelopePayload(envelope.payload, settings);
}

export async function publishRuntimeArtifacts({
  artifactUrls,
  dbSnapshot = null,
  backupSnapshot = null,
  runtimeSnapshot = null,
  eligibleSnapshot = null,
  sqliteChanged = false,
  sqliteData = null,
  putObject = putObjectWithRetry,
} = {}) {
  if (!artifactUrls?.backupUrl || !artifactUrls?.runtimeUrl || !artifactUrls?.sqliteUrl) {
    throw new Error("artifactUrls.backupUrl, artifactUrls.runtimeUrl, and artifactUrls.sqliteUrl are required");
  }

  const backupArtifact = await buildBackupArtifact(backupSnapshot ?? dbSnapshot);
  const runtimeArtifact = await buildRuntimeArtifact(runtimeSnapshot ?? dbSnapshot);
  const eligibleArtifact = await buildEligibleRuntimeArtifact(eligibleSnapshot ?? runtimeSnapshot ?? dbSnapshot);
  const credentialsArtifact = await buildFullCredentialsArtifact(eligibleSnapshot ?? runtimeSnapshot ?? dbSnapshot);
  const runtimeConfigArtifact = await buildRuntimeConfigArtifact(runtimeSnapshot ?? dbSnapshot);
  const result = {
    backup: null,
    runtime: null,
    eligible: null,
    credentials: null,
    runtimeConfig: null,
    sqlite: null,
  };

  try {
    const backupUpload = await putObject({
      objectUrl: artifactUrls.backupUrl,
      body: JSON.stringify(backupArtifact),
      contentType: "application/json",
    });
    result.backup = createUploadResult(backupUpload);
  } catch (error) {
    result.backup = createUploadFailureResult(error);
  }

  try {
    const runtimeUpload = await putObject({
      objectUrl: artifactUrls.runtimeUrl,
      body: JSON.stringify(runtimeArtifact),
      contentType: "application/json",
    });
    result.runtime = createUploadResult(runtimeUpload);
  } catch (error) {
    result.runtime = createUploadFailureResult(error);
  }

  try {
    const eligibleUpload = await putObject({
      objectUrl: artifactUrls.eligibleUrl || artifactUrls.runtimeUrl.replace(/runtime\.json$/, "eligible.json"),
      body: JSON.stringify(eligibleArtifact),
      contentType: "application/json",
    });
    result.eligible = createUploadResult(eligibleUpload);
  } catch (error) {
    result.eligible = createUploadFailureResult(error);
  }

  if (!sqliteChanged) {
    result.sqlite = {
      ok: true,
      uploaded: false,
      skipped: true,
      attempts: 0,
    };
  } else {
    try {
      const sqliteUpload = await putObject({
        objectUrl: artifactUrls.sqliteUrl,
        body: sqliteData,
        contentType: "application/octet-stream",
      });
      result.sqlite = createUploadResult(sqliteUpload);
    } catch (error) {
      result.sqlite = createUploadFailureResult(error);
    }
  }

  if (artifactUrls.fullRuntimeUrl) {
    try {
      const credentialsUpload = await putObject({
        objectUrl: artifactUrls.fullRuntimeUrl,
        body: JSON.stringify(credentialsArtifact),
        contentType: "application/json",
      });
      result.credentials = createUploadResult(credentialsUpload);
    } catch (error) {
      result.credentials = createUploadFailureResult(error);
    }
  } else {
    result.credentials = { ok: true, uploaded: false, skipped: true, attempts: 0 };
  }

  if (artifactUrls.runtimeConfigUrl) {
    try {
      const runtimeConfigUpload = await putObject({
        objectUrl: artifactUrls.runtimeConfigUrl,
        body: JSON.stringify(runtimeConfigArtifact),
        contentType: "application/json",
      });
      result.runtimeConfig = createUploadResult(runtimeConfigUpload);
    } catch (error) {
      result.runtimeConfig = createUploadFailureResult(error);
    }
  } else {
    result.runtimeConfig = { ok: true, uploaded: false, skipped: true, attempts: 0 };
  }

  return result;
}

export async function publishRuntimeArtifactsFromSettings({
  settings = null,
  dbSnapshot = null,
  putObject = putObjectWithRetry,
  fingerprintReader = computeSqliteFingerprint,
  settingsUpdater = updateSettings,
  settingsReader = getSettings,
} = {}) {
  const initialSettings = settings || await settingsReader();
  const needsBackupEncryptionKey = Boolean(initialSettings?.r2Config && !initialSettings?.r2BackupEncryptionKey);
  let resolvedSettings = initialSettings;
  const generatedBackupEncryptionKey = initialSettings?.r2Config
    ? ensureBackupEncryptionKey(initialSettings)
    : null;

  if (needsBackupEncryptionKey) {
    const updatedSettings = await settingsUpdater({ r2BackupEncryptionKey: generatedBackupEncryptionKey });
    if (updatedSettings?.r2BackupEncryptionKey) {
      resolvedSettings = updatedSettings;
    } else if (!settings) {
      const rereadSettings = await settingsReader();
      if (rereadSettings?.r2BackupEncryptionKey) {
        resolvedSettings = rereadSettings;
      } else {
        throw new Error("Failed to persist backup encryption key");
      }
    }
  }

  const backupEncryptionKey = resolvedSettings?.r2BackupEncryptionKey || generatedBackupEncryptionKey;

  const encryptionSettings = backupEncryptionKey
    ? { ...resolvedSettings, r2BackupEncryptionKey: backupEncryptionKey }
    : resolvedSettings;
  const artifactUrls = resolvedSettings?.r2Config
    ? buildArtifactWriteUrls(resolvedSettings)
    : buildArtifactUrls(resolvedSettings?.r2RuntimePublicBaseUrl);
  const snapshot = dbSnapshot || await exportDb();
  const uploadWithAuth = async (request) => putObject({
    ...request,
    r2Config: resolvedSettings?.r2Config || null,
  });
  let sqliteState = null;
  let sqliteFailure = null;

  try {
    sqliteState = fingerprintReader();
  } catch (error) {
    sqliteFailure = createUploadFailureResult(error);
  }

  const previousFingerprint = resolvedSettings?.r2LastSqliteBackupFingerprint || null;
  const sqliteChanged = sqliteState
    ? hasSqliteChanged({
        nextFingerprint: sqliteState.fingerprint,
        previousFingerprint,
      })
    : false;
  const backupSnapshot = resolvedSettings?.r2Config
    ? buildEncryptedBackupArtifact(snapshot, encryptionSettings, sqliteState)
    : snapshot;
  const sqliteData = resolvedSettings?.r2Config && sqliteState?.data
    ? buildEncryptedSqliteEnvelope(sqliteState.data, encryptionSettings)
    : sqliteState?.data || null;
  const publishResult = await publishRuntimeArtifacts({
    artifactUrls,
    dbSnapshot: snapshot,
    backupSnapshot,
    runtimeSnapshot: snapshot,
    eligibleSnapshot: snapshot,
    sqliteChanged,
    sqliteData,
    putObject: uploadWithAuth,
  });

  if (sqliteFailure) {
    publishResult.sqlite = sqliteFailure;
  }

  const timestamp = new Date().toISOString();
  const settingsPatch = {};

  if (
    publishResult.backup?.ok === true &&
    publishResult.runtime?.ok === true &&
    publishResult.eligible?.ok === true &&
    publishResult.credentials?.ok === true &&
    publishResult.runtimeConfig?.ok === true
  ) {
    settingsPatch.r2LastRuntimePublishAt = timestamp;
  }

  if (publishResult.sqlite?.uploaded && sqliteState?.fingerprint) {
    settingsPatch.r2LastBackupAt = timestamp;
    settingsPatch.r2LastSqliteBackupFingerprint = sqliteState.fingerprint;
  }

  if (Object.keys(settingsPatch).length > 0) {
    await settingsUpdater(settingsPatch);
  }

  return {
    ...publishResult,
    sqliteFingerprint: sqliteState?.fingerprint || null,
    sqliteChanged,
  };
}

export async function readBackupArtifactFromSettings({
  settings = null,
  fetchImpl = fetch,
} = {}) {
  const resolvedSettings = settings || await getSettings();
  const { artifactUrl, artifact } = await readSignedJsonArtifact(
    resolvedSettings?.r2Config,
    buildBackupObjectKey(resolvedSettings),
    fetchImpl
  );
  const artifactUrls = {
    backupUrl: artifactUrl,
    runtimeUrl: resolvedSettings?.r2RuntimePublicBaseUrl
      ? buildArtifactUrls(resolvedSettings.r2RuntimePublicBaseUrl).runtimeUrl
      : null,
    eligibleUrl: resolvedSettings?.r2RuntimePublicBaseUrl
      ? buildArtifactUrls(resolvedSettings.r2RuntimePublicBaseUrl).eligibleUrl
      : null,
    sqliteUrl: buildR2ObjectUrl(resolvedSettings?.r2Config, buildSqliteObjectKey(resolvedSettings)),
  };

  return {
    artifactUrl,
    artifact,
    artifactUrls,
  };
}

export async function restoreFromDirectBackupSettings({
  settings = null,
  fetchImpl = fetch,
} = {}) {
  const resolvedSettings = settings || await getSettings();
  const { artifact } = await readBackupArtifactFromSettings({ settings: resolvedSettings, fetchImpl });
  const sqliteKey = artifact?.sqlite?.key || buildSqliteObjectKey(resolvedSettings);

  if (!sqliteKey) {
    throw new Error("Backup artifact does not include a SQLite backup key");
  }

  const backupData = decryptSqliteEnvelope(
    await readSignedBinaryArtifact(resolvedSettings?.r2Config, sqliteKey, fetchImpl),
    resolvedSettings
  );
  const backupLocalPath = `${DB_SQLITE_FILE}.pre-restore-${Date.now()}`;

  await prepareLocalDbForExternalRestore();

  if (fs.existsSync(DB_SQLITE_FILE)) {
    fs.copyFileSync(DB_SQLITE_FILE, backupLocalPath);
  }

  fs.writeFileSync(DB_SQLITE_FILE, backupData);
  await reloadLocalDbAfterExternalRestore();

  return {
    success: true,
    restoredBackup: artifact?.sqlite?.key || "sqlite/latest.db",
    backupSize: backupData.length,
    previousBackup: fs.existsSync(backupLocalPath) ? backupLocalPath : null,
    restoredAt: new Date().toISOString(),
  };
}

function normalizeUrl(url) {
  return String(url || "").replace(/\/$/, "");
}

/**
 * Get R2 config from settings
 */
export async function getR2Config() {
  const settings = await getSettings();
  return settings.r2Config || null;
}

/**
 * Get worker entries with R2 configured
 */
async function getR2WorkerEntries() {
  const settings = await getSettings();
  const cloudUrls = Array.isArray(settings.cloudUrls) ? settings.cloudUrls : [];
  return cloudUrls.filter(c => c?.url && c?.secret);
}

/**
 * Make authenticated request to worker R2 endpoint
 */
async function r2Request(workerUrl, secret, path, options = {}) {
  const url = `${normalizeUrl(workerUrl)}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      "X-Cloud-Secret": secret,
    },
    signal: AbortSignal.timeout(options.timeout || REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* ignore */ }
    throw new Error(`R2 request failed (${res.status}): ${message}`);
  }

  return res;
}

/**
 * Test direct R2 bucket connectivity using the configured bucket endpoint.
 */
export async function testR2Connection(config) {
  const url = buildR2BucketProbeUrl(config);
  const headers = signR2Request({
    method: "GET",
    url,
    r2Config: config,
  });
  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* ignore */ }
    throw new Error(`R2 request failed (${res.status}): ${message}`);
  }

  return { success: true };
}

/**
 * Upload SQLite database backup to R2 via worker
 */
export async function uploadSqliteBackup(workerUrl, secret) {
  const machineId = await getConsistentMachineId();

  if (!fs.existsSync(DB_SQLITE_FILE)) {
    throw new Error(`SQLite file not found: ${DB_SQLITE_FILE}`);
  }

  const data = fs.readFileSync(DB_SQLITE_FILE);
  const res = await r2Request(workerUrl, secret, `/r2/backup/sqlite/${machineId}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: data,
    timeout: 60_000,
  });

  return res.json();
}

/**
 * Upload SQLite backup to all configured workers
 */
export async function uploadSqliteBackupToAll() {
  const entries = await getR2WorkerEntries();
  if (entries.length === 0) {
    throw new Error("No cloud workers configured");
  }

  const results = await Promise.allSettled(
    entries.map(entry => uploadSqliteBackup(entry.url, entry.secret))
  );

  const successes = results.filter(r => r.status === "fulfilled").length;
  const failures = results
    .filter(r => r.status === "rejected")
    .map(r => r.reason?.message || "unknown");

  return { successes, failures, total: entries.length };
}

/**
 * List SQLite backups from worker R2
 */
export async function listSqliteBackups(workerUrl, secret) {
  const machineId = await getConsistentMachineId();
  const res = await r2Request(workerUrl, secret, `/r2/backup/sqlite?machineId=${encodeURIComponent(machineId)}`);
  return res.json();
}

/**
 * Download SQLite backup from worker R2
 */
export async function downloadSqliteBackup(workerUrl, secret, backupKey) {
  const machineId = await getConsistentMachineId();
  const params = new URLSearchParams({ machineId, key: backupKey });
  const res = await r2Request(workerUrl, secret, `/r2/backup/sqlite/download?${params}`, {
    timeout: 60_000,
  });
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Upload usage data backup to R2 via worker
 */
export async function uploadUsageBackup(workerUrl, secret, usageData) {
  const machineId = await getConsistentMachineId();
  const res = await r2Request(workerUrl, secret, `/r2/usage/${machineId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(usageData),
  });
  return res.json();
}

/**
 * Upload request logs backup to R2 via worker
 */
export async function uploadRequestLogBackup(workerUrl, secret, requestData) {
  const machineId = await getConsistentMachineId();
  const res = await r2Request(workerUrl, secret, `/r2/requests/${machineId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestData),
  });
  return res.json();
}

/**
 * Export all data from worker R2 (for restore/rollback)
 */
export async function exportFromR2(workerUrl, secret) {
  const machineId = await getConsistentMachineId();
  const res = await r2Request(workerUrl, secret, `/r2/export/${machineId}`);
  return res.json();
}

/**
 * Get R2 storage info from worker
 */
export async function getR2Info(workerUrl, secret) {
  const machineId = await getConsistentMachineId();
  const res = await r2Request(workerUrl, secret, `/r2/info?machineId=${encodeURIComponent(machineId)}`);
  return res.json();
}

/**
 * Restore all data from R2 to local 9Router
 * Downloads the latest SQLite backup and replaces the local database
 */
export async function restoreFromR2(workerUrl, secret) {
  const machineId = await getConsistentMachineId();

  // Get latest backup info
  const backupsRes = await listSqliteBackups(workerUrl, secret);
  const backups = backupsRes?.backups || [];

  if (backups.length === 0) {
    throw new Error("No backups found in R2");
  }

  // Get the most recent backup
  const latestBackup = backups[backups.length - 1];

  // Download the backup
  const backupData = await downloadSqliteBackup(workerUrl, secret, latestBackup.key);

  // Write to data directory
  const backupLocalPath = `${DB_SQLITE_FILE}.pre-restore-${Date.now()}`;

  // Backup current database before restoring
  if (fs.existsSync(DB_SQLITE_FILE)) {
    fs.copyFileSync(DB_SQLITE_FILE, backupLocalPath);
  }

  // Write restored database
  fs.writeFileSync(DB_SQLITE_FILE, backupData);

  // Also export and restore provider data / settings
  const exportData = await exportFromR2(workerUrl, secret);

  return {
    success: true,
    restoredBackup: latestBackup.key,
    backupSize: backupData.length,
    previousBackup: fs.existsSync(backupLocalPath) ? backupLocalPath : null,
    exportData: exportData?.machineData || null,
    restoredAt: new Date().toISOString()
  };
}

/**
 * Backup usage data to all workers periodically
 */
export async function backupUsageToAll(usageData) {
  const entries = await getR2WorkerEntries();
  if (entries.length === 0) return { successes: 0, total: 0 };

  const results = await Promise.allSettled(
    entries.map(entry => uploadUsageBackup(entry.url, entry.secret, usageData))
  );

  return {
    successes: results.filter(r => r.status === "fulfilled").length,
    total: entries.length
  };
}

/**
 * Backup request logs to all workers
 */
export async function backupRequestLogsToAll(requestData) {
  const entries = await getR2WorkerEntries();
  if (entries.length === 0) return { successes: 0, total: 0 };

  const results = await Promise.allSettled(
    entries.map(entry => uploadRequestLogBackup(entry.url, entry.secret, requestData))
  );

  return {
    successes: results.filter(r => r.status === "fulfilled").length,
    total: entries.length
  };
}
