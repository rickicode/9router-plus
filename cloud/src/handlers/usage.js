// cloud/src/handlers/usage.js
import { getAllUsage } from "../services/usage.js";
import { getState } from "../services/state.js";
import * as log from "../utils/logger.js";

/**
 * GET /worker/usage/:machineId
 * Return usage stats for all connections
 */
export async function handleUsage(request, env, machineId) {
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
