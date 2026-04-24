// cloud/src/services/state.js

/**
 * Global in-memory state for worker
 * Reset on cold start
 */
const workerState = {
  // Round-robin indexes per provider
  roundRobinIndexes: new Map(),  // provider → index
  
  // Sticky sessions
  stickyMap: new Map(),          // apiKey → {connectionId, expiresAt}
  
  // Usage tracking per connection
  usage: new Map(),              // connectionId → {requests, tokensInput, tokensOutput, errors, lastUsed}
  
  // Last sync timestamp
  lastSyncAt: null,
  
  // Worker start time
  startedAt: Date.now()
};

/**
 * Get current state
 */
export function getState() {
  return workerState;
}

/**
 * Update last sync timestamp
 */
export function updateLastSync() {
  workerState.lastSyncAt = new Date().toISOString();
}

/**
 * Get worker uptime in seconds
 */
export function getUptime() {
  return Math.floor((Date.now() - workerState.startedAt) / 1000);
}

/**
 * Clear all state (for testing)
 */
export function clearState() {
  workerState.roundRobinIndexes.clear();
  workerState.stickyMap.clear();
  workerState.usage.clear();
  workerState.lastSyncAt = null;
}

/**
 * Clean up expired sticky sessions
 */
export function cleanupExpiredSessions() {
  const state = getState();
  const now = Date.now();
  let cleaned = 0;

  for (const [apiKey, session] of state.stickyMap.entries()) {
    if (session.expiresAt <= now) {
      state.stickyMap.delete(apiKey);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[STATE] Cleaned ${cleaned} expired sticky sessions`);
  }
}

/**
 * Limit usage map size (LRU-style)
 */
export function limitUsageMapSize(maxSize = 1000) {
  const state = getState();
  if (state.usage.size <= maxSize) return;

  // Sort by lastUsed, keep most recent
  const entries = Array.from(state.usage.entries())
    .sort((a, b) => {
      const timeA = new Date(a[1].lastUsed || 0).getTime();
      const timeB = new Date(b[1].lastUsed || 0).getTime();
      return timeB - timeA;
    })
    .slice(0, maxSize);

  state.usage.clear();
  entries.forEach(([key, value]) => state.usage.set(key, value));

  console.log(`[STATE] Limited usage map to ${maxSize} entries`);
}
