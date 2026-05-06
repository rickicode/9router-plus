// cloud/src/handlers/usage.js
import { getAllUsage, getUsageEvents } from "../services/usage.js";
import { getState } from "../services/state.js";
import { isWorkerSharedSecretValid } from "../utils/secret.js";
import * as log from "../utils/logger.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function authorizeUsageRequest(request, env) {
  if (!isWorkerSharedSecretValid(request, env)) {
    return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401) };
  }

  return { ok: true };
}

/**
 * GET /worker/usage
 * Return usage stats for all connections in the shared runtime.
 */
export async function handleUsage(request, env) {
  // CORS preflight support
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*"
      }
    });
  }

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  const auth = await authorizeUsageRequest(request, env);
  if (!auth.ok) return auth.response;

  const state = getState();
  const usage = getAllUsage();

  const response = {
    timestamp: new Date().toISOString(),
    lastSyncAt: state.lastSyncAt,
    usage
  };

  log.info("USAGE", `Returned stats for ${Object.keys(usage).length} connections`);

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export async function handleAdminUsageEvents(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*"
      }
    });
  }

  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(request.url);

  const auth = await authorizeUsageRequest(request, env);
  if (!auth.ok) return auth.response;

  const result = getUsageEvents({
    cursor: url.searchParams.get("cursor"),
    limit: url.searchParams.get("limit"),
  });

  log.info("USAGE", `Returned ${result.events.length} buffered events`);
  return jsonResponse({
    success: true,
    ...result,
  });
}
