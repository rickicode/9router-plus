// Usage Worker Scheduler - Simple timer-based scheduler

import { getSettings, getProviderConnections } from "@/lib/localDb.js";
import { refreshConnectionUsage } from "@/lib/connectionUsageRefresh.js";
import { runDedupedUsageRefreshJob } from "@/lib/usageRefreshQueue.js";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers.js";
import { prioritizeConnections } from "./prioritizer.js";
import { normalizeUsageWorkerSettings } from "./config.js";

function isFutureTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Boolean(value) && Number.isFinite(timestamp) && timestamp > Date.now();
}

export function isUsageRefreshableConnection(connection) {
  const waitingForQuotaReset = (connection?.routingStatus === "exhausted" || connection?.quotaState === "exhausted")
    && isFutureTimestamp(connection?.resetAt);

  return USAGE_SUPPORTED_PROVIDERS.includes(connection?.provider)
    && connection?.authType === "oauth"
    && connection?.isActive !== false
    && !waitingForQuotaReset
    && connection?.routingStatus !== "disabled"
    && connection?.authState !== "invalid"
    && connection?.reasonCode !== "auth_invalid"
    && connection?.reasonCode !== "reauthorization_required";
}

function getConnectionLogLabel(connection) {
  const identity = connection?.email
    || connection?.displayName
    || connection?.connectionName
    || connection?.name
    || connection?.id?.slice(0, 8)
    || "unknown";
  return `${connection?.provider || "provider"}:${identity}`;
}

async function processWithConcurrency(items, concurrency, worker, shouldContinue = () => true) {
  const limit = Math.max(1, Math.min(items.length, concurrency));
  let nextIndex = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      if (!shouldContinue()) return;

      const index = nextIndex;
      nextIndex += 1;

      await worker(items[index], index);
    }
  });

  await Promise.allSettled(runners);
}

export class UsageScheduler {
  constructor({ logger = console, onStatusChange = null } = {}) {
    this.logger = logger;
    this.onStatusChange = typeof onStatusChange === "function" ? onStatusChange : null;
    this.lastStatusNotifyAt = 0;
    this.enabled = false;
    this.settings = null;
    this.timerId = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastRunStats = null;
    this.startedAt = null;
    this.nextRunAt = null;
    this.currentRun = null;
    this.queuedRun = null;
    this.activeRun = null;
    this.runSequence = 0;
  }

  notifyStatusChange({ force = false } = {}) {
    if (!this.onStatusChange) return;

    const now = Date.now();
    if (!force && now - this.lastStatusNotifyAt < 1000) return;
    this.lastStatusNotifyAt = now;
    this.onStatusChange(this.getStatus());
  }

  async loadSettings() {
    const dbSettings = await getSettings();
    this.settings = normalizeUsageWorkerSettings(dbSettings.usageWorker || {});
    this.enabled = this.settings.enabled;
  }

  async start() {
    this.startedAt = this.startedAt || new Date().toISOString();
    await this.loadSettings();

    if (!this.enabled) {
      this.nextRunAt = null;
      this.logger.log?.("[UsageWorker] Scheduler disabled in settings");
      return;
    }

    this.logger.log?.("[UsageWorker] Starting scheduler...");
    this.scheduleNext();
    this.logger.log?.("[UsageWorker] Scheduler started; waiting for next scheduled run");
  }

  scheduleNext() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }

    if (!this.enabled) return;

    const intervalMs = this.settings.intervalMinutes * 60 * 1000;
    this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();

    this.timerId = setTimeout(() => {
      this.runConnections({ trigger: "timer", mode: "all" }).catch(error => {
        this.logger.error?.("[UsageWorker] Timer run failed:", error);
      });
    }, intervalMs);

    // Allow process to exit if this is the only thing keeping it alive
    if (typeof this.timerId?.unref === 'function') {
      this.timerId.unref();
    }
  }

  async runBatch(trigger = "manual") {
    if (this.running) {
      this.logger.warn?.("[UsageWorker] Batch already running, skipping");
      return this.lastRunStats;
    }

    return this.runConnections({ trigger, mode: "batch" });
  }

  requestFullRefresh(trigger = "manual_full_refresh") {
    if (this.running) {
      if (this.activeRun) {
        this.activeRun.cancelled = true;
      }
      if (this.currentRun) {
        this.currentRun.restartRequested = true;
      }
      this.queuedRun = { trigger, mode: "all" };
      this.logger.warn?.("[UsageWorker] Current run will be replaced by requested full refresh");
      this.notifyStatusChange({ force: true });
      return {
        accepted: true,
        queued: false,
        overrideRequested: true,
        status: this.getStatus(),
      };
    }

    this.runConnections({ trigger, mode: "all" }).catch((error) => {
      this.logger.error?.("[UsageWorker] Full refresh failed:", error);
    });

    return {
      accepted: true,
      queued: false,
      status: this.getStatus(),
    };
  }

  async runConnections({ trigger = "manual", mode = "batch" } = {}) {
    if (this.running) {
      this.logger.warn?.("[UsageWorker] Run already running, skipping");
      return this.lastRunStats;
    }

    this.running = true;
    this.nextRunAt = null;
    const runContext = { id: this.runSequence += 1, cancelled: false };
    this.activeRun = runContext;
    const startedAt = new Date();
    const isFullRefresh = mode === "all";

    this.logger.log?.(`[UsageWorker] Run started | trigger=${trigger} | mode=${mode} | at=${startedAt.toISOString()}`);

    const stats = {
      trigger,
      mode,
      startedAt: startedAt.toISOString(),
      total: 0,
      success: 0,
      error: 0,
      skipped: 0,
      duration: 0,
    };

    this.currentRun = {
      trigger,
      mode,
      startedAt: stats.startedAt,
      progress: {
        totalCount: 0,
        completedCount: 0,
        successCount: 0,
        errorCount: 0,
        skippedCount: 0,
      },
    };
    this.notifyStatusChange({ force: true });

    try {
      // Reload settings in case they changed
      await this.loadSettings();

      if (!this.enabled && !isFullRefresh) {
        this.logger.log?.("[UsageWorker] Scheduler disabled, stopping");
        this.stop();
        return stats;
      }

      const allConnections = await getProviderConnections();
      const candidates = isFullRefresh
        ? allConnections
          .filter(isUsageRefreshableConnection)
          .map((connection) => ({ connection, reason: trigger === "manual_full_refresh" ? "manual_full_refresh" : "scheduled_full_refresh" }))
        : prioritizeConnections(allConnections, this.settings, startedAt);
      const batch = isFullRefresh ? candidates : candidates.slice(0, this.settings.batchSize);
      stats.total = batch.length;
      this.currentRun.progress.totalCount = batch.length;
      this.notifyStatusChange({ force: true });

      if (batch.length === 0) {
        this.logger.log?.("[UsageWorker] No connections to refresh");
        return stats;
      }

      const concurrency = isFullRefresh ? this.settings.batchSize : batch.length;
      this.logger.log?.(
        `[UsageWorker] Processing ${batch.length} connections ` +
        `(${candidates.length} refresh candidates) with concurrency=${concurrency}`
      );
      this.currentRun.progress.currentBatchStart = 1;
      this.currentRun.progress.currentBatchEnd = batch.length;

      await processWithConcurrency(batch, concurrency, async (entry, index) => {
        const { connection, reason } = entry;
        const accountLabel = getConnectionLogLabel(connection);
        const progressLabel = `${index + 1}/${batch.length}`;

        try {
          const runRefresh = async () => {
            this.logger.log?.(
              `[UsageWorker] → ${progressLabel} ${accountLabel} | reason=${reason} | checking`
            );

            const result = await refreshConnectionUsage(connection.id, {
              runConnectionTest: isFullRefresh,
              skipTransientConnectivityErrors: true,
            });

            if (result.skipped) {
              stats.skipped++;
              this.currentRun.progress.skippedCount++;
            } else {
              stats.success++;
              this.currentRun.progress.successCount++;
            }

            const statusLabel = result.skipReason
              ? "unchanged"
              : (result.connection?.routingStatus || "unknown");

            this.logger.log?.(
              `[UsageWorker] ✓ ${progressLabel} ${accountLabel} | ` +
              `reason=${reason} | status=${statusLabel}${result.skipReason ? ` | skipped=${result.skipReason}` : ""}`
            );

            return result;
          };

          if (isFullRefresh) {
            await runRefresh();
          } else {
            await runDedupedUsageRefreshJob(connection.id, runRefresh);
          }
        } catch (error) {
          stats.error++;
          this.currentRun.progress.errorCount++;
          this.logger.error?.(
            `[UsageWorker] ✗ ${progressLabel} ${accountLabel} | ` +
            `reason=${reason} | error=${error.message}`
          );
        } finally {
          this.currentRun.progress.completedCount++;
          this.notifyStatusChange();
        }
      }, () => !runContext.cancelled);

      const finishedAt = new Date();
      stats.finishedAt = finishedAt.toISOString();
      stats.duration = finishedAt.getTime() - startedAt.getTime();
      stats.cancelled = runContext.cancelled;

      this.logger.log?.(
        `[UsageWorker] Run ${runContext.cancelled ? "cancelled" : "finished"} | mode=${mode} | ` +
        `success=${stats.success} error=${stats.error} skipped=${stats.skipped} | ` +
        `duration=${stats.duration}ms`
      );

      this.lastRunAt = finishedAt.toISOString();
      this.lastRunStats = stats;
      this.notifyStatusChange({ force: true });

      return stats;
    } catch (error) {
      this.logger.error?.("[UsageWorker] Run failed:", error);
      throw error;
    } finally {
      this.running = false;
      this.currentRun = null;
      if (this.activeRun === runContext) {
        this.activeRun = null;
      }
      this.notifyStatusChange({ force: true });
      const queuedRun = this.queuedRun;
      this.queuedRun = null;

      if (queuedRun) {
        this.runConnections(queuedRun).catch((error) => {
          this.logger.error?.("[UsageWorker] Queued run failed:", error);
        });
      } else if (this.enabled) {
        this.scheduleNext();
      }
    }
  }

  stop() {
    this.logger.log?.("[UsageWorker] Stopping scheduler...");

    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.nextRunAt = null;
    this.currentRun = null;
    this.queuedRun = null;
    if (this.activeRun) {
      this.activeRun.cancelled = true;
    }

    this.enabled = false;
    this.logger.log?.("[UsageWorker] Scheduler stopped");
  }

  getStatus() {
    const status = this.running ? "running" : this.enabled ? "idle" : "disabled";

    return {
      enabled: this.enabled,
      running: this.running,
      status,
      settings: this.settings,
      lastRunAt: this.lastRunAt,
      lastRunStats: this.lastRunStats,
      startedAt: this.startedAt,
      lastRun: this.lastRunStats ? {
        ...this.lastRunStats,
        finishedAt: this.lastRunAt,
      } : null,
      currentRun: this.currentRun,
      progress: this.currentRun?.progress || null,
      queuedRun: this.queuedRun,
      restartRequested: this.currentRun?.restartRequested === true,
      nextRunAt: this.nextRunAt,
    };
  }
}
