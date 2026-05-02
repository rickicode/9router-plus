import * as log from "../utils/logger.js";
import {
  deleteMachineData,
  getMachineData,
  getRuntimeConfig,
  saveRuntimeSyncPayload,
} from "../services/storage.js";
import { updateLastSync } from "../services/state.js";
import { isWorkerSharedSecretValid } from "../utils/secret.js";

const WORKER_RECORD_ID = "shared";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

function normalizeRuntimeSyncPayload(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid JSON body" };
  }

  if (!body.providers || typeof body.providers !== "object" || Array.isArray(body.providers)) {
    return { error: "Missing providers object" };
  }

  if (body.modelAliases !== undefined && (!body.modelAliases || typeof body.modelAliases !== "object" || Array.isArray(body.modelAliases))) {
    return { error: "Invalid modelAliases object" };
  }

  if (body.settings !== undefined && (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings))) {
    return { error: "Invalid settings object" };
  }

  if (body.apiKeys !== undefined && !Array.isArray(body.apiKeys)) {
    return { error: "Invalid apiKeys array" };
  }

  if (body.combos !== undefined && !Array.isArray(body.combos)) {
    return { error: "Invalid combos array" };
  }

  return {
    generatedAt: typeof body.generatedAt === "string" && body.generatedAt ? body.generatedAt : new Date().toISOString(),
    strategy: typeof body.strategy === "string" && body.strategy ? body.strategy : "priority",
    providers: body.providers,
    modelAliases: body.modelAliases || {},
    combos: body.combos || [],
    apiKeys: body.apiKeys || [],
    settings: body.settings || {},
  };
}

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

  switch (request.method) {
    case "GET":
      return handleGet(request, machineId, env);
    case "POST":
      return handlePost(request, machineId, env);
    case "DELETE":
      return handleDelete(request, machineId, env);
    default:
      return jsonResponse({ error: "Method not allowed" }, 405);
  }
}

async function authorize(request, machineId, env, { requireExisting = true } = {}) {
  const data = await getMachineData(WORKER_RECORD_ID, env);

  if (!data) {
    if (requireExisting) {
      log.warn("SYNC", "Machine not registered", { machineId });
      return { ok: false, response: jsonResponse({ error: "Machine not registered. Call POST /admin/register first." }, 404) };
    }
    return { ok: true, data: null };
  }

  if (!isWorkerSharedSecretValid(request, env)) {
    log.warn("SYNC", "Invalid shared secret", { machineId });
    return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401) };
  }

  return { ok: true, data };
}

async function handleGet(request, machineId, env) {
  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;

  const data = await getRuntimeConfig(machineId, env, { forceRefresh: true });
  log.info("SYNC", "Runtime config retrieved", { machineId });
  return jsonResponse({
    success: true,
    machineId,
    data,
  });
}

async function handlePost(request, machineId, env) {
  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("SYNC", "Invalid JSON body", { machineId });
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const payload = normalizeRuntimeSyncPayload(body);
  if (payload.error) {
    log.warn("SYNC", payload.error, { machineId });
    return jsonResponse({ error: payload.error }, 400);
  }

  const syncResult = await saveRuntimeSyncPayload(machineId, payload, env);
  updateLastSync();

  log.info("SYNC", "Publisher runtime payload synced to D1", {
    machineId,
    providerCount: syncResult.providerCount,
    modelAliasCount: syncResult.modelAliasCount,
    comboCount: syncResult.comboCount,
    apiKeyCount: syncResult.apiKeyCount,
  });

  return jsonResponse({
    success: true,
    machineId,
    syncMode: "publisher-to-d1",
    pruneBehavior: "provider_sync/api_keys/model_aliases/combos/settings replaced from publisher payload",
    runtimePreservation: "provider_runtime_state preserved for providers still present; deleted for providers pruned from payload",
    receivedAt: new Date().toISOString(),
    generatedAt: syncResult.generatedAt,
    providerCount: syncResult.providerCount,
    modelAliasCount: syncResult.modelAliasCount,
    comboCount: syncResult.comboCount,
    apiKeyCount: syncResult.apiKeyCount,
  });
}

async function handleDelete(request, machineId, env) {
  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;

  await deleteMachineData(machineId, env);

  log.info("SYNC", "Runtime config deleted", { machineId });
  return jsonResponse({
    success: true,
    machineId,
    message: "Runtime config deleted successfully"
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}
