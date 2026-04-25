/**
 * Single source of truth for fields that count as "hot state" — i.e. fields
 * that should live on the hot_state SQLite table (or in-memory cache) instead
 * of being mirrored to the providerConnections row body.
 *
 * Keep this list in sync with sanitizeHotState/extractHotState. Adding a key
 * here automatically affects both providerHotState.js (the cache + persistence
 * layer) and sqliteHelpers.js (the entity sanitizer) so we never drift.
 */

export const HOT_STATE_KEYS = new Set([
  "routingStatus",
  "healthStatus",
  "quotaState",
  "authState",
  "reasonCode",
  "reasonDetail",
  "nextRetryAt",
  "resetAt",
  "lastCheckedAt",
  "usageSnapshot",
  "version",
  "lastUsedAt",
  "consecutiveUseCount",
  "backoffLevel",
  "expiresIn",
  "updatedAt",
]);

export function isHotStateKey(key) {
  return HOT_STATE_KEYS.has(key) || (typeof key === "string" && key.startsWith("modelLock_"));
}
