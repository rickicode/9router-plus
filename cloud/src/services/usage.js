// cloud/src/services/usage.js
import { getState, maybeResetUsageEvents } from "./state.js";
import * as log from "../utils/logger.js";

const MAX_USAGE_EVENTS = 1000;

function normalizeEvent(event = {}) {
  return {
    timestamp: event.timestamp || new Date().toISOString(),
    type: event.type || "request",
    endpoint: event.endpoint || null,
    provider: event.provider || null,
    model: event.model || null,
    connectionId: event.connectionId || null,
    status: Number(event.status) || 0,
    tokensInput: Number(event.tokensInput) || 0,
    tokensOutput: Number(event.tokensOutput) || 0,
    error: event.error ? String(event.error).slice(0, 500) : null,
    latencyMs: Number(event.latencyMs) || 0,
  };
}

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

export function recordUsageEvent(event = {}) {
  const state = getState();
  maybeResetUsageEvents();

  state.usageCursor += 1;
  const usageEvent = {
    cursor: state.usageCursor,
    ...normalizeEvent(event),
  };

  state.usageEvents.push(usageEvent);
  if (state.usageEvents.length > MAX_USAGE_EVENTS) {
    state.usageEvents.splice(0, state.usageEvents.length - MAX_USAGE_EVENTS);
  }

  return usageEvent;
}

export function getUsageEvents({ cursor = 0, limit = 500 } = {}) {
  const state = getState();
  maybeResetUsageEvents();

  const safeCursor = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 500));
  const events = state.usageEvents
    .filter((event) => event.cursor > safeCursor)
    .slice(0, safeLimit);
  const latestCursor = state.usageEvents.length > 0
    ? state.usageEvents[state.usageEvents.length - 1].cursor
    : state.usageCursor;
  const nextCursor = events.length > 0 ? events[events.length - 1].cursor : safeCursor;

  return {
    events,
    nextCursor,
    latestCursor,
    hasMore: state.usageEvents.some((event) => event.cursor > nextCursor),
    lastResetAt: new Date(state.lastUsageResetAt).toISOString(),
    nextResetAt: new Date(state.lastUsageResetAt + state.usageResetIntervalMs).toISOString(),
    resetEveryMs: state.usageResetIntervalMs,
  };
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
