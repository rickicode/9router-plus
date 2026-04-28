import { getConsistentMachineId } from "@/shared/utils/machineId";
import {
  getProviderConnections,
  getModelAliases,
  getCombos,
  getSettings,
  getApiKeys,
  atomicUpdateSettings,
} from "./localDb.js";
import { getActiveCloudEntry } from "./cloudUrlResolver.js";

const SYNC_TIMEOUT_MS = 10_000;

/**
 * Format a provider connection for cloud sync.
 *
 * Previously this only sent (id, provider, accessToken, refreshToken,
 * expiresAt, isActive), which silently dropped fields that API-key providers
 * (OpenAI/Anthropic key, OpenRouter, GLM, Kimi, MiniMax) and OAuth providers
 * with extra metadata (Gemini projectId, Cursor idToken, Kiro scope, etc.)
 * rely on. The Worker's `formatProviderData` already accepts all of these
 * fields, so we now mirror the full schema.
 */
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

async function buildSyncPayload() {
  const [connections, modelAliases, combos, apiKeys, settings] = await Promise.all([
    getProviderConnections(),
    getModelAliases(),
    getCombos(),
    getApiKeys(),
    getSettings(),
  ]);

  return {
    providers: connections.map(formatConnection),
    modelAliases,
    combos,
    // NOTE: API keys/tokens are sent to the worker in plaintext application
    // payloads; encrypting these end-to-end would require a separate KMS.
    apiKeys,
    settings: {
      routing: settings.routing || {},
    },
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

/**
 * Sync config to a single cloud worker entry.
 * @param {Object} entry - cloudUrls[] entry with { id, url, secret }
 * @param {Object} payload - sync payload from buildSyncPayload()
 * @param {string} machineId
 */
async function syncToWorker(entry, payload, machineId) {
  const url = `${String(entry.url).replace(/\/$/, "")}/sync/${machineId}`;
  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cloud-Secret": entry.secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error?.name === "AbortError" ? "timeout" : error?.message || "fetch failed";
    await updateCloudUrlEntry(entry.id, {
      status: "offline",
      lastSyncOk: false,
      lastSyncError: message,
      lastChecked: new Date().toISOString(),
    });
    throw new Error(`Sync to ${entry.url} failed: ${message}`);
  }

  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }

    const status =
      response.status === 401 ? "unauthorized"
      : response.status === 404 ? "not_registered"
      : "error";

    await updateCloudUrlEntry(entry.id, {
      status,
      lastSyncOk: false,
      lastSyncError: message,
      latencyMs,
      lastChecked: new Date().toISOString(),
    });
    throw new Error(`Sync to ${entry.url} failed (${response.status}): ${message}`);
  }

  const result = await response.json();

  await updateCloudUrlEntry(entry.id, {
    status: "online",
    lastSyncOk: true,
    lastSyncAt: new Date().toISOString(),
    lastSyncError: null,
    providersCount: result?.credentialsCount ?? null,
    latencyMs,
    lastChecked: new Date().toISOString(),
  });

  return result;
}

/**
 * Sync config to ALL configured cloud workers.
 *
 * Workers without a `secret` are skipped because they have not completed the
 * register flow. Failures on individual workers are isolated — one bad worker
 * does not block sync to others.
 */
export async function syncToCloud() {
  const machineId = await getConsistentMachineId();
  const settings = await getSettings();
  const cloudUrls = Array.isArray(settings.cloudUrls) ? settings.cloudUrls : [];
  const eligible = cloudUrls.filter((c) => c?.url && c?.secret);

  if (eligible.length === 0) {
    throw new Error("No cloud worker configured");
  }

  const payload = await buildSyncPayload();

  const results = await Promise.allSettled(
    eligible.map((entry) => syncToWorker(entry, payload, machineId))
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
  };
}

/**
 * Helper for the "active" worker entry (used by single-worker callers).
 * Returns null if not configured.
 */
export async function syncToCloudActive() {
  const entry = await getActiveCloudEntry();
  if (!entry) return null;
  const machineId = await getConsistentMachineId();
  const payload = await buildSyncPayload();
  return syncToWorker(entry, payload, machineId);
}
