// cloud/src/services/usage.js
import { getState } from "./state.js";
import * as log from "../utils/logger.js";

/**
 * Record usage for a connection
 * @param {string} connectionId
 * @param {number} tokensInput
 * @param {number} tokensOutput
 * @param {Error|null} error
 */
export function recordUsage(connectionId, tokensInput = 0, tokensOutput = 0, error = null) {
  const state = getState();
  let stats = state.usage.get(connectionId);

  if (!stats) {
    stats = {
      requests: 0,
      tokensInput: 0,
      tokensOutput: 0,
      errors: 0,
      lastUsed: null
    };
    state.usage.set(connectionId, stats);
  }

  stats.requests++;
  stats.tokensInput += tokensInput;
  stats.tokensOutput += tokensOutput;
  if (error) stats.errors++;
  stats.lastUsed = new Date().toISOString();

  log.debug("USAGE", `Recorded for ${connectionId}: +${tokensInput}/${tokensOutput} tokens`);
}

/**
 * Get all usage stats
 * @returns {Object} Usage stats by connection ID
 */
export function getAllUsage() {
  const state = getState();
  const usage = {};

  for (const [connectionId, stats] of state.usage.entries()) {
    usage[connectionId] = { ...stats };
  }

  return usage;
}

/**
 * Clear usage stats (for testing)
 */
export function clearUsage() {
  const state = getState();
  state.usage.clear();
}
