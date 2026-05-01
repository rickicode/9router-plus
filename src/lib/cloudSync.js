import {
  getSettings,
  atomicUpdateSettings,
} from "./localDb.js";
import { getActiveCloudEntry } from "./cloudUrlResolver.js";
import { refreshWorkerRuntime } from "./cloudWorkerClient.js";
import { publishRuntimeArtifactsFromSettings } from "./r2BackupClient.js";

function formatConnection(conn) {
  return {
    id: conn.id,
    provider: conn.provider,
    authType: conn.authType,
    name: conn.name,
    displayName: conn.displayName,
    email: conn.email,
    priority: conn.priority,
    globalPriority: conn.globalPriority,
    defaultModel: conn.defaultModel,
    accessToken: conn.accessToken,
    refreshToken: conn.refreshToken,
    expiresAt: conn.expiresAt,
    expiresIn: conn.expiresIn,
    tokenType: conn.tokenType,
    scope: conn.scope,
    idToken: conn.idToken,
    projectId: conn.projectId,
    apiKey: conn.apiKey,
    providerSpecificData: conn.providerSpecificData || {},
    isActive: conn.isActive !== false,
    routingStatus: conn.routingStatus,
    authState: conn.authState,
    healthStatus: conn.healthStatus,
    quotaState: conn.quotaState,
    reasonCode: conn.reasonCode,
    reasonDetail: conn.reasonDetail,
    nextRetryAt: conn.nextRetryAt,
    resetAt: conn.resetAt,
    lastCheckedAt: conn.lastCheckedAt,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

async function updateCloudUrlEntry(entryId, patch) {
  await atomicUpdateSettings(async (current) => {
    const cloudUrls = Array.isArray(current.cloudUrls) ? current.cloudUrls.map((c) => ({ ...c })) : [];
    const idx = cloudUrls.findIndex((c) => c.id === entryId);
    if (idx === -1) return current;
    cloudUrls[idx] = { ...cloudUrls[idx], ...patch };
    return { ...current, cloudUrls };
  });
}

function formatPublishFailure(result = {}) {
  return Object.entries({
    backup: result.backup,
    runtime: result.runtime,
    eligible: result.eligible,
    credentials: result.credentials,
    runtimeConfig: result.runtimeConfig,
    sqlite: result.sqlite,
  })
    .filter(([, value]) => value?.ok === false)
    .map(([name, value]) => `${name}: ${value?.error || "upload failed"}`)
    .join("; ");
}

function hasValidPrivateR2Config(settings = {}) {
  const config = settings?.r2Config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return false;
  }

  const requiredFields = [
    config.accountId,
    config.accessKeyId,
    config.secretAccessKey,
    config.bucket,
    config.endpoint,
    config.region,
  ];

  return requiredFields.every((value) => String(value || "").trim() !== "");
}

async function ensureWorkerRuntimeArtifacts(settings) {
  if (!hasValidPrivateR2Config(settings)) {
    throw new Error("Cloud sync requires a valid private R2 configuration so the worker runtime artifacts can be uploaded");
  }

  const publishResult = await publishRuntimeArtifactsFromSettings({ settings });
  const requiredArtifacts = [
    publishResult.backup,
    publishResult.runtime,
    publishResult.eligible,
    publishResult.credentials,
    publishResult.runtimeConfig,
  ];

  if (requiredArtifacts.some((artifact) => artifact?.ok !== true)) {
    const reason = formatPublishFailure(publishResult) || "required runtime artifact upload failed";
    throw new Error(`Cloud sync aborted: ${reason}`);
  }

  return publishResult;
}

async function syncToWorker(entry, secret, { skipRefresh = false, publishResult = null } = {}) {
  const startedAt = Date.now();

  if (skipRefresh) {
    const syncedAt = publishResult?.runtimeUploadSkipped ? (publishResult?.runtimeGeneratedAt || new Date().toISOString()) : new Date().toISOString();
    const latencyMs = Date.now() - startedAt;
    await updateCloudUrlEntry(entry.id, {
      status: "online",
      lastSyncOk: true,
      lastSyncAt: syncedAt,
      lastSyncError: null,
      latencyMs,
      lastChecked: new Date().toISOString(),
    });
    return {
      success: true,
      refreshedAt: syncedAt,
      skipped: true,
    };
  }

  let response;
  try {
    response = await refreshWorkerRuntime(entry.url, secret);
  } catch (error) {
    const status = error?.status === 401 ? "unauthorized"
      : error?.status === 404 ? "not_registered"
      : error?.name === "AbortError" ? "offline"
      : "error";
    const message = error?.name === "AbortError" ? "timeout" : error?.message || "fetch failed";
    await updateCloudUrlEntry(entry.id, {
      status,
      lastSyncOk: false,
      lastSyncError: message,
      lastChecked: new Date().toISOString(),
    });
    throw new Error(`Runtime refresh for ${entry.url} failed${error?.status ? ` (${error.status})` : ""}: ${message}`);
  }

  const latencyMs = Date.now() - startedAt;

  await updateCloudUrlEntry(entry.id, {
    status: "online",
    lastSyncOk: true,
    lastSyncAt: response?.refreshedAt || new Date().toISOString(),
    lastSyncError: null,
    latencyMs,
    lastChecked: new Date().toISOString(),
  });

  return response;
}

export async function syncToCloud() {
  const settings = await getSettings();
  const cloudUrls = Array.isArray(settings.cloudUrls) ? settings.cloudUrls : [];
  const eligible = cloudUrls.filter((c) => c?.url);
  const secret = typeof settings.cloudSharedSecret === "string" ? settings.cloudSharedSecret : "";

  if (eligible.length === 0) {
    throw new Error("No cloud worker configured");
  }
  if (!secret) {
    throw new Error("Global cloud shared secret is missing. Regenerate it in Endpoint -> Cloud.");
  }

  const publishResult = await ensureWorkerRuntimeArtifacts(settings);
  const shouldRefreshWorkers = publishResult.runtimeUploadSkipped !== true;
  const results = await Promise.allSettled(
    eligible.map((entry) => syncToWorker(entry, secret, {
      skipRefresh: !shouldRefreshWorkers,
      publishResult,
    }))
  );

  const successes = results.filter((r) => r.status === "fulfilled");
  const failures = results
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason?.message || "unknown error");

  if (successes.length === 0) {
    throw new Error(failures.join("; ") || "Cloud sync failed");
  }

  return {
    success: true,
    syncedAt: new Date().toISOString(),
    workersOk: successes.length,
    workersFailed: failures.length,
    failures,
    runtimeArtifactsPublishedAt: settings.r2LastRuntimePublishAt || null,
    runtimeArtifactUpload: {
      backup: publishResult.backup,
      runtime: publishResult.runtime,
      eligible: publishResult.eligible,
      credentials: publishResult.credentials,
      runtimeConfig: publishResult.runtimeConfig,
      sqlite: publishResult.sqlite,
    },
    runtimeUploadSkipped: publishResult.runtimeUploadSkipped === true,
    runtimeArtifactHash: publishResult.artifactHash || null,
  };
}

export async function syncToCloudActive() {
  const settings = await getSettings();
  const entry = await getActiveCloudEntry();
  if (!entry) return null;
  const secret = typeof settings.cloudSharedSecret === "string" ? settings.cloudSharedSecret : "";
  if (!secret) {
    throw new Error("Global cloud shared secret is missing. Regenerate it in Endpoint -> Cloud.");
  }
  const publishResult = await ensureWorkerRuntimeArtifacts(settings);
  return syncToWorker(entry, secret, {
    skipRefresh: publishResult.runtimeUploadSkipped === true,
    publishResult,
  });
}
