// cloud/src/handlers/health.js
import { getRuntimeConfig } from "../services/storage.js";
import { getState, getUptime } from "../services/state.js";
import { isWorkerSharedSecretValid } from "../utils/secret.js";
import * as log from "../utils/logger.js";

const WORKER_RECORD_ID = "shared";

/**
 * GET /worker/health
 * Return health status based on last sync time
 */
export async function handleHealth(request, env) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (!isWorkerSharedSecretValid(request, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const state = getState();
  const data = await getRuntimeConfig(WORKER_RECORD_ID, env);

  // Calculate sync age
  let syncAge = null;
  let status = "down";

  if (state.lastSyncAt) {
    syncAge = Math.floor((Date.now() - new Date(state.lastSyncAt).getTime()) / 1000);

    if (syncAge < 60) {
      status = "healthy";
    } else if (syncAge < 300) {
      status = "degraded";
    } else {
      status = "down";
    }
  } else if (data) {
    // Has data but no sync yet (cold start)
    status = "initializing";
    syncAge = 0;
  }

  const response = {
    status,
    lastSyncAt: state.lastSyncAt,
    syncAge,
    details: {
      hasMachineData: !!data,
      credentialsCount: data ? Object.keys(data.providers || {}).length : 0,
      lastSyncError: null,
      uptime: getUptime()
    }
  };

  log.info("HEALTH", `Status: ${status}, syncAge: ${syncAge}s`);

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
