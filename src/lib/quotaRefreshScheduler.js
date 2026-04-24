import { getProviderConnections, getSettings } from "@/lib/localDb";
import { getConnectionHotStates } from "@/lib/providerHotState";
import { normalizeQuotaSchedulerSettings, planQuotaRefreshCandidates } from "@/lib/quotaRefreshPlanner";
import { createQuotaRefreshState, QUOTA_REFRESH_RUN_STATES } from "@/lib/quotaRefreshState";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { applyCanonicalUsageRefresh } from "@/lib/usageStatus";

const DEFAULT_QUOTA_EXHAUSTED_THRESHOLD_PERCENT = 10;

function normalizeQuotaExhaustedThresholdPercent(value) {
  if (!Number.isFinite(value)) return DEFAULT_QUOTA_EXHAUSTED_THRESHOLD_PERCENT;
  return Math.min(100, Math.max(0, value));
}

const appGlobal = global.__appSingleton ??= {};

export class QuotaRefreshScheduler {
  constructor({
    getSettingsFn = getSettings,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    now = () => new Date(),
    logger = console,
  } = {}) {
    this.getSettingsFn = getSettingsFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.now = now;
    this.logger = logger;
    this.state = createQuotaRefreshState({ now: () => this.now().toISOString() });
    this.settings = normalizeQuotaSchedulerSettings({});
    this.quotaExhaustedThresholdPercent = DEFAULT_QUOTA_EXHAUSTED_THRESHOLD_PERCENT;
    this.resolvedConfig = {
      quotaScheduler: { ...this.settings },
      quotaExhaustedThresholdPercent: this.quotaExhaustedThresholdPercent,
    };
    this.timerId = null;
    this.started = false;
    this.startPromise = null;
  }

  async loadSettings() {
    const settings = await this.getSettingsFn();
    this.settings = normalizeQuotaSchedulerSettings(settings?.quotaScheduler || {});
    this.quotaExhaustedThresholdPercent = normalizeQuotaExhaustedThresholdPercent(
      settings?.quotaExhaustedThresholdPercent
    );
    this.resolvedConfig = {
      quotaScheduler: { ...this.settings },
      quotaExhaustedThresholdPercent: this.quotaExhaustedThresholdPercent,
    };
    return this.settings;
  }

  buildStatusSnapshot() {
    return {
      started: this.started,
      enabled: this.settings.enabled,
      settings: { ...this.settings },
      resolvedConfig: {
        quotaScheduler: { ...this.resolvedConfig.quotaScheduler },
        quotaExhaustedThresholdPercent: this.resolvedConfig.quotaExhaustedThresholdPercent,
      },
      hasScheduledTimer: this.timerId !== null,
      ...this.getStateSnapshot(),
    };
  }

  getStateSnapshot() {
    return this.state.getSnapshot();
  }

  async getStatusSnapshot({ refreshSettings = false } = {}) {
    if (refreshSettings) {
      await this.loadSettings();
    }

    return this.buildStatusSnapshot();
  }

  isStarted() {
    return this.started;
  }

  async start() {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.started) {
      return this;
    }

    this.startPromise = (async () => {
      this.started = true;
      try {
        await this.refreshSchedule("startup");
        return this;
      } catch (error) {
        this.started = false;
        this.clearScheduledTimer();
        throw error;
      }
    })();

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  stop() {
    this.started = false;
    this.clearScheduledTimer();
    this.state.reset({ preserveLastRun: true });
    return this.getStateSnapshot();
  }

  async refreshSchedule(reason = "settings") {
    await this.loadSettings();

    if (!this.started || !this.settings.enabled) {
      this.clearScheduledTimer();
      this.state.setNextScheduledAt(null);
      return this.buildStatusSnapshot();
    }

    const nextScheduledAt = new Date(this.now().getTime() + this.settings.cadenceMs);
    this.scheduleAt(nextScheduledAt, reason);
    return this.buildStatusSnapshot();
  }

  async requestRestart(reason = "manual") {
    this.state.requestRestart(reason);
    return this.refreshSchedule(reason);
  }

  async requestManualRun(reason = "manual") {
    await this.loadSettings();

    if (!this.settings.enabled) {
      this.clearScheduledTimer();
      this.state.setNextScheduledAt(null);
      return {
        accepted: false,
        reason: "scheduler_disabled",
        snapshot: this.buildStatusSnapshot(),
      };
    }

    if (!this.started) {
      await this.start();
    }

    const status = this.state.getSnapshot().status;
    const mode = (
      status === QUOTA_REFRESH_RUN_STATES.RUNNING
      || status === QUOTA_REFRESH_RUN_STATES.CANCELLING
    )
      ? "restart_requested"
      : "run_triggered";

    if (mode === "restart_requested") {
      const snapshot = await this.requestRestart(reason);
      return {
        accepted: true,
        reason: mode,
        snapshot,
      };
    }

    this.clearScheduledTimer();
    this.state.setNextScheduledAt(null);
    const snapshot = await this.runSweep(reason);
    return {
      accepted: true,
      reason: mode,
      snapshot,
    };
  }

  async runSweep(trigger = "timer") {
    const startedAt = this.now();
    this.logger.log?.(
      `[QuotaRefreshScheduler] Run started | trigger=${trigger} | at=${startedAt.toISOString()}`
    );

    const { status } = this.state.getSnapshot();
    if (
      status === QUOTA_REFRESH_RUN_STATES.RUNNING
      || status === QUOTA_REFRESH_RUN_STATES.CANCELLING
    ) {
      this.state.requestRestart(`${trigger}:overlap`);
      return this.buildStatusSnapshot();
    }

    const nowIso = startedAt.toISOString();
    const connections = await getProviderConnections({ isActive: true });
    const connectionRefs = connections.map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      providerId: connection.provider,
    }));
    const hotStateMap = await getConnectionHotStates(connectionRefs);
    const hotStateByConnectionId = {};
    for (const connection of connections) {
      hotStateByConnectionId[connection.id] = hotStateMap.get(`${connection.provider}:${connection.id}`)
        || hotStateMap.get(connection.id)
        || {};
    }

    const planned = planQuotaRefreshCandidates({
      connections,
      schedulerSettings: this.settings,
      hotStateByConnectionId,
      now: nowIso,
    });
    const dueEntries = planned.filter((entry) => entry?.decision?.due);
    const totalCount = dueEntries.length;

    this.state.startRun({
      trigger,
      metadata: {
        cadenceMs: this.settings.cadenceMs,
        plannedCount: planned.length,
        dueCount: totalCount,
      },
      progress: {
        totalCount,
        completedCount: 0,
        successCount: 0,
        errorCount: 0,
        skippedCount: 0,
        currentBatchStart: null,
        currentBatchEnd: null,
      },
    });

    try {
      let completedCount = 0;
      let successCount = 0;
      let errorCount = 0;
      let skippedCount = 0;
      const batchSize = Math.max(1, this.settings.batchSize || 1);

      const sweepConcurrency = 3;
      for (let index = 0; index < dueEntries.length; index += batchSize) {
        const batch = dueEntries.slice(index, index + batchSize);
        const currentBatchStart = index + 1;
        const currentBatchEnd = index + batch.length;

        this.state.updateProgress({
          totalCount,
          completedCount,
          successCount,
          errorCount,
          skippedCount,
          currentBatchStart,
          currentBatchEnd,
        });

        for (let batchOffset = 0; batchOffset < batch.length; batchOffset += sweepConcurrency) {
          const chunk = batch.slice(batchOffset, batchOffset + sweepConcurrency);
          const chunkResults = await Promise.all(chunk.map(async (entry) => {
            const connection = entry?.connection;
            if (!connection) {
              return { type: "skipped" };
            }

            try {
              const usage = await getUsageForProvider(connection);
              await applyCanonicalUsageRefresh(connection, usage, {
                globalExhaustedThreshold: this.quotaExhaustedThresholdPercent,
              });
              return { type: "success" };
            } catch (error) {
              this.logger.error?.(
                `[QuotaRefreshScheduler] Refresh failed | connectionId=${connection.id} | provider=${connection.provider}`,
                error
              );
              return { type: "error" };
            }
          }));

          for (const result of chunkResults) {
            if (result.type === "success") successCount += 1;
            else if (result.type === "error") errorCount += 1;
            else skippedCount += 1;
            completedCount += 1;
          }

          this.state.updateProgress({
            totalCount,
            completedCount,
            successCount,
            errorCount,
            skippedCount,
            currentBatchStart,
            currentBatchEnd,
          });
        }
      }

      this.state.finishRun({
        trigger,
        outcome: "completed",
        processedCount: completedCount,
        successCount,
        errorCount,
        skippedCount,
      });
      if (this.started) {
        try {
          const { isCloudEnabled } = await import("@/lib/localDb");
          const { syncToCloud } = await import("@/lib/cloudSync");
          if (await isCloudEnabled()) {
            try {
              await syncToCloud();
              this.logger?.log?.("[QuotaRefreshScheduler] Cloud sync triggered after quota check");
            } catch (error) {
              this.logger?.error?.("[QuotaRefreshScheduler] Cloud sync failed, will retry next cycle:", error);
            }
          }
        } catch (error) {
          this.logger?.error?.("[QuotaRefreshScheduler] Cloud sync failed:", error);
        }
      }
      this.logger.log?.(
        `[QuotaRefreshScheduler] Run finished | trigger=${trigger} | outcome=completed | processed=${completedCount}/${totalCount} | success=${successCount} | error=${errorCount} | skipped=${skippedCount} | durationMs=${this.now().getTime() - startedAt.getTime()}`
      );
    } catch (error) {
      this.logger.error?.("[QuotaRefreshScheduler] Sweep run failed:", error);
      this.state.failRun(error);
    }

    const postRunSnapshot = this.state.getSnapshot();
    const pendingRestartReason = postRunSnapshot.restartRequested
      ? postRunSnapshot.lastRun?.restartReason || `${trigger}:restart`
      : null;

    if (pendingRestartReason && this.started && this.settings.enabled) {
      this.clearScheduledTimer();
      this.state.setNextScheduledAt(null);
      return this.runSweep(pendingRestartReason);
    }

    if (this.started) {
      await this.refreshSchedule("post-run");
    }

    return this.buildStatusSnapshot();
  }

  scheduleAt(nextScheduledAt, reason = "schedule") {
    this.clearScheduledTimer();

    const delayMs = Math.max(0, nextScheduledAt.getTime() - this.now().getTime());
    this.state.setNextScheduledAt(nextScheduledAt.toISOString());
    this.timerId = this.setTimeoutFn(() => {
      this.timerId = null;
      this.runSweep(reason).catch((error) => {
        this.logger.error?.("[QuotaRefreshScheduler] Timer run failed:", error);
        this.state.failRun(error);
      });
    }, delayMs);

    if (typeof this.timerId?.unref === "function") {
      this.timerId.unref();
    }

    return this.timerId;
  }

  clearScheduledTimer() {
    if (!this.timerId) return;
    this.clearTimeoutFn(this.timerId);
    this.timerId = null;
  }
}

export function getQuotaRefreshScheduler(options = {}) {
  if (!appGlobal.quotaRefreshScheduler) {
    appGlobal.quotaRefreshScheduler = new QuotaRefreshScheduler(options);
  }

  return appGlobal.quotaRefreshScheduler;
}
