// Usage Worker Prioritizer - Smart prioritization for connection refresh

import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";

/**
 * Priority rules (lower number = higher priority):
 * 0-99: Critical (never checked, no snapshot)
 * 100-199: High (exhausted with reset time passed)
 * 200-299: Medium (stale connections)
 * 300+: Low (fresh connections)
 * 999999: Skip (waiting for reset time)
 */

const PRIORITY = {
  NEVER_CHECKED: 0,
  NO_SNAPSHOT: 50,
  RESET_TIME_PASSED: 100,
  STALE_BASE: 200,
  FRESH: 999999,
};

export function prioritizeConnections(connections, settings, now = new Date()) {
  const nowTs = now.getTime();
  const intervalMs = (settings.intervalMinutes || 15) * 60 * 1000;

  return connections
    .filter(conn => isEligibleForRefresh(conn))
    .map(conn => {
      const priority = calculatePriority(conn, nowTs, intervalMs);
      const reason = getRefreshReason(conn, nowTs, intervalMs);

      return {
        connection: conn,
        priority,
        reason,
      };
    })
    .filter(entry => entry.priority < PRIORITY.FRESH)
    .sort((a, b) => {
      // Sort by priority (lower = higher priority)
      if (a.priority !== b.priority) return a.priority - b.priority;
      // If same priority, sort by lastCheckedAt (older first)
      const aTime = new Date(a.connection.lastCheckedAt || 0).getTime();
      const bTime = new Date(b.connection.lastCheckedAt || 0).getTime();
      return aTime - bTime;
    });
}

function isEligibleForRefresh(connection) {
  // Must be OAuth and active
  if (connection.authType !== 'oauth') return false;
  if (connection.isActive === false) return false;

  // Must be supported provider
  if (!USAGE_SUPPORTED_PROVIDERS.includes(connection.provider)) return false;

  // Disabled connections should not be refreshed
  if (connection.routingStatus === 'disabled') return false;

  return true;
}

function calculatePriority(connection, nowTs, intervalMs) {
  // Never checked - highest priority
  if (!connection.lastCheckedAt) {
    return PRIORITY.NEVER_CHECKED;
  }

  // No usage snapshot - high priority
  if (!connection.usageSnapshot) {
    return PRIORITY.NO_SNAPSHOT;
  }

  const lastCheckedTs = new Date(connection.lastCheckedAt).getTime();
  const ageMs = nowTs - lastCheckedTs;

  // Exhausted connections
  if (connection.routingStatus === 'exhausted' || connection.quotaState === 'exhausted') {
    if (connection.resetAt) {
      const resetTs = new Date(connection.resetAt).getTime();

      // Reset time has passed - refresh now
      if (nowTs >= resetTs) {
        return PRIORITY.RESET_TIME_PASSED;
      }

      // Still waiting for reset - skip
      return PRIORITY.FRESH;
    }

    // No resetAt (credit-based like Kiro) - treat as stale
    // This ensures credit-based exhausted accounts get refreshed
    return PRIORITY.STALE_BASE + Math.floor(ageMs / 1000);
  }

  // Stale connections (age > interval)
  if (ageMs > intervalMs) {
    return PRIORITY.STALE_BASE + Math.floor(ageMs / 1000);
  }

  // Fresh connections - skip
  return PRIORITY.FRESH;
}

function getRefreshReason(connection, nowTs, intervalMs) {
  if (!connection.lastCheckedAt) return 'never_checked';
  if (!connection.usageSnapshot) return 'missing_snapshot';

  const lastCheckedTs = new Date(connection.lastCheckedAt).getTime();
  const ageMs = nowTs - lastCheckedTs;

  if (connection.routingStatus === 'exhausted' || connection.quotaState === 'exhausted') {
    if (connection.resetAt) {
      const resetTs = new Date(connection.resetAt).getTime();
      if (nowTs >= resetTs) return 'reset_time_passed';
      return 'waiting_for_reset';
    }
    return 'exhausted_no_reset';
  }

  if (ageMs > intervalMs) return 'stale';
  return 'fresh';
}
