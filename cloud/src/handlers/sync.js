import * as log from "../utils/logger.js";
import { getMachineData, saveMachineData, deleteMachineData } from "../services/storage.js";
import { updateLastSync } from "../services/state.js";
import { extractSecret, isSecretValid } from "../utils/secret.js";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

// Removed: WORKER_FIELDS and WORKER_SPECIFIC_FIELDS
// Now syncing entire provider based on updatedAt (simpler logic)

export async function handleSync(request, env, ctx) {
  const url = new URL(request.url);
  const machineId = url.pathname.split("/")[2]; // /sync/:machineId

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*"
      }
    });
  }

  if (!machineId) {
    log.warn("SYNC", "Missing machineId in path");
    return jsonResponse({ error: "Missing machineId" }, 400);
  }

  // Route by method
  switch (request.method) {
    case "GET":
      return handleGet(request, machineId, env);
    case "POST":
      return jsonResponse({
        error: "Sync writes are deprecated for runtime state. Publish backup.json and runtime.json from 9router-plus, then register runtimeUrl via /admin/register.",
        runtimeUrlRequired: true
      }, 410);
    case "DELETE":
      return jsonResponse({
        error: "Sync deletes are deprecated. Runtime configuration is owned by the direct R2 artifacts written by 9router-plus.",
        runtimeUrlRequired: true
      }, 410);
    default:
      return jsonResponse({ error: "Method not allowed" }, 405);
  }
}

/**
 * Helper: load machine data and verify the presented secret.
 * Returns either { ok: true, data } or { ok: false, response }.
 */
async function authorize(request, machineId, env, { requireExisting = true } = {}) {
  const data = await getMachineData(machineId, env);
  const presented = extractSecret(request);

  if (!data) {
    if (requireExisting) {
      log.warn("SYNC", "Machine not registered", { machineId });
      return { ok: false, response: jsonResponse({ error: "Machine not registered. Call POST /admin/register first." }, 404) };
    }
    return { ok: true, data: null };
  }

  if (!isSecretValid(presented, data)) {
    log.warn("SYNC", "Invalid secret", { machineId });
    return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401) };
  }

  return { ok: true, data };
}

/**
 * GET /sync/:machineId - Return merged data for Web to update
 */
async function handleGet(request, machineId, env) {
  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;
  const data = auth.data;

  log.info("SYNC", "Data retrieved", { machineId });
  return jsonResponse({
    success: true,
    data
  });
}

/**
 * POST /sync/:machineId - Merge Web data with Worker data
 * providers stored by ID (supports multiple connections per provider)
 */
async function handlePost(request, machineId, env) {
  // Secret-based auth — machine MUST already be registered via /admin/register.
  // The previous "bootstrap unauth" path has been removed because it allowed
  // any caller who knew the machineId to seed initial credentials.
  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;
  const data = auth.data;

  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("SYNC", "Invalid JSON body", { machineId });
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  // Validate required fields
  if (!body.providers || !Array.isArray(body.providers)) {
    log.warn("SYNC", "Missing or invalid providers array", { machineId });
    return jsonResponse({ error: "Missing providers array" }, 400);
  }

  // Add settings validation
  if (body.settings && (typeof body.settings !== 'object' || body.settings === null)) {
    log.warn("SYNC", "Invalid settings object", { machineId });
    return jsonResponse({ error: "Invalid settings object" }, 400);
  }

  const existingData = data;

  // Merge providers by ID
  const mergedProviders = {};
  const changes = { updated: [], fromWorker: [] };

  for (const webProvider of body.providers) {
    const providerId = webProvider.id;
    if (!providerId) {
      log.warn("SYNC", "Provider missing id", { provider: webProvider.provider });
      continue;
    }

    const workerProvider = existingData.providers[providerId];

    if (workerProvider) {
      // Merge: token fields from Worker, config fields from Web
      mergedProviders[providerId] = mergeProvider(webProvider, workerProvider, changes, providerId);
    } else {
      // New provider from Web
      mergedProviders[providerId] = formatProviderData(webProvider);
      changes.updated.push(providerId);
    }
  }

  // Prepare final data - modelAliases, apiKeys, combos always from Web.
  // `meta` (secret, registeredAt, …) is never overwritten by sync payloads.
  const now = new Date().toISOString();
  const previousMeta = existingData.meta || {};
  const finalData = {
    providers: mergedProviders,
    modelAliases: body.modelAliases || existingData.modelAliases || {},
    combos: body.combos || existingData.combos || [],
    apiKeys: body.apiKeys || existingData.apiKeys || [],
    settings: body.settings || existingData.settings || {},
    meta: {
      ...previousMeta,
      lastSyncAt: now,
      syncCount: (previousMeta.syncCount || 0) + 1
    },
    updatedAt: now
  };

  // Store in R2 + invalidate cache
  await saveMachineData(machineId, finalData, env);

  // Update state last sync timestamp
  updateLastSync();

  log.info("SYNC", "Data synced successfully", {
    machineId,
    providerCount: Object.keys(mergedProviders).length,
    changes
  });

  return jsonResponse({
    success: true,
    syncId: `sync_${Date.now()}`,
    receivedAt: new Date().toISOString(),
    credentialsCount: Object.keys(mergedProviders).length,
    modelsCount: Object.keys(finalData.modelAliases || {}).length,
    combosCount: (finalData.combos || []).length
  });
}

/**
 * DELETE /sync/:machineId - Clear all data for this machine.
 * Now requires a valid secret — the previous implementation accepted DELETE
 * from anyone who knew the machineId, which let strangers wipe state.
 */
async function handleDelete(request, machineId, env) {
  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;

  await deleteMachineData(machineId, env);

  log.info("SYNC", "Data deleted", { machineId });
  return jsonResponse({
    success: true,
    message: "Data deleted successfully"
  });
}

/**
 * Merge provider data: compare updatedAt to decide which source to use
 * Simple logic: newer wins (sync entire provider)
 */
function mergeProvider(webProvider, workerProvider, changes, providerId) {
  const webTime = new Date(webProvider.updatedAt || 0).getTime();
  const workerTime = new Date(workerProvider.updatedAt || 0).getTime();

  let merged;
  
  if (workerTime > webTime) {
    // Cloud has newer data - use entire Cloud provider
    merged = formatProviderData(workerProvider);
    changes.fromWorker.push(providerId);
  } else {
    // Server has newer data - use entire Server provider
    merged = formatProviderData(webProvider);
    changes.updated.push(providerId);
  }

  // Always update timestamp
  merged.updatedAt = new Date().toISOString();
  return merged;
}

/**
 * Format provider data for storage
 */
function formatProviderData(provider) {
  return {
    id: provider.id,
    provider: provider.provider,
    authType: provider.authType,
    name: provider.name,
    displayName: provider.displayName,
    email: provider.email,
    priority: provider.priority,
    globalPriority: provider.globalPriority,
    defaultModel: provider.defaultModel,
    accessToken: provider.accessToken,
    refreshToken: provider.refreshToken,
    expiresAt: provider.expiresAt,
    expiresIn: provider.expiresIn,
    tokenType: provider.tokenType,
    scope: provider.scope,
    idToken: provider.idToken,
    projectId: provider.projectId,
    apiKey: provider.apiKey,
    providerSpecificData: provider.providerSpecificData || {},
    isActive: provider.isActive,
    routingStatus: provider.routingStatus || "eligible",
    authState: provider.authState || "ok",
    healthStatus: provider.healthStatus || "healthy",
    quotaState: provider.quotaState || "ok",
    reasonCode: provider.reasonCode || "unknown",
    reasonDetail: provider.reasonDetail || null,
    nextRetryAt: provider.nextRetryAt || null,
    resetAt: provider.resetAt || null,
    lastCheckedAt: provider.lastCheckedAt || null,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt || new Date().toISOString()
  };
}

/**
 * Update provider status (called when token refresh fails or API errors)
 */
export function updateProviderStatus(providers, providerId, routingStatus, reasonDetail = null, reasonCode = null) {
  if (providers[providerId]) {
    providers[providerId].routingStatus = routingStatus || "eligible";
    providers[providerId].reasonDetail = reasonDetail;
    providers[providerId].reasonCode = reasonCode || (reasonDetail ? "usage_request_failed" : "unknown");
    providers[providerId].lastCheckedAt = new Date().toISOString();
    providers[providerId].updatedAt = new Date().toISOString();
  }
  return providers;
}

/**
 * Helper to create JSON response
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}
