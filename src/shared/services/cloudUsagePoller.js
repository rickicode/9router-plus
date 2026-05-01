import { getConsistentMachineId } from "@/shared/utils/machineId";
import { atomicUpdateProviderConnection } from "@/lib/localDb";
import { getCloudUrl } from "@/lib/cloudUrlResolver";

const DEFAULT_CLOUD_USAGE_POLL_INTERVAL_MS = 15000;

function normalizeCloudUsage(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeCloudUsage);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeCloudUsage(value[key]);
        return acc;
      }, {});
  }

  return value ?? null;
}

function isSameCloudUsage(left, right) {
  return JSON.stringify(normalizeCloudUsage(left)) === JSON.stringify(normalizeCloudUsage(right));
}

/**
 * Cloud usage poller
 * Polls worker usage endpoint every interval
 */
export class CloudUsagePoller {
  constructor(machineId = null, intervalMs = DEFAULT_CLOUD_USAGE_POLL_INTERVAL_MS) {
    this.machineId = machineId;
    this.intervalMs = intervalMs;
    this.intervalId = null;
    this.machineIdPromise = null;
    this.lastError = null;
    this.lastPollDuration = null;
    this.lastPollSuccess = false;
    this.pollInFlight = null;
  }

  /**
   * Initialize machine ID if not provided
   */
  async initializeMachineId() {
    if (!this.machineId) {
      this.machineIdPromise ??= getConsistentMachineId();
      this.machineId = await this.machineIdPromise;
    }

    return this.machineId;
  }

  /**
   * Start polling
   */
  async start() {
    if (this.intervalId) return;

    await this.initializeMachineId();

    this.runPollCycle().catch((error) => {
      console.error("[CloudUsagePoller] Poll failed:", error);
    });

    this.intervalId = setInterval(() => {
      this.runPollCycle().catch((error) => {
        console.error("[CloudUsagePoller] Poll failed:", error);
      });
    }, this.intervalMs);
  }

  /**
   * Stop polling
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async runPollCycle() {
    if (this.pollInFlight) {
      return this.pollInFlight;
    }

    this.pollInFlight = this.poll();
    try {
      return await this.pollInFlight;
    } finally {
      this.pollInFlight = null;
    }
  }

  /**
   * Poll usage from worker
   */
  async poll() {
    await this.initializeMachineId();

    if (!this.machineId) {
      console.error("[CloudUsagePoller] No machineId available");
      return;
    }

    let cloudUrl = "";
    try {
      cloudUrl = await getCloudUrl();
      if (!cloudUrl || !cloudUrl.startsWith("http")) {
        console.error("[CloudUsagePoller] Invalid cloud URL");
        return;
      }
    } catch (error) {
      console.error("[CloudUsagePoller] Cloud URL unavailable:", error);
      return;
    }

    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(`${cloudUrl}/worker/usage/${this.machineId}`, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          this.lastError = `Poll failed: ${response.statusText}`;
          console.error("[CloudUsagePoller] Failed:", response.statusText);
          return;
        }

        this.lastError = null;
        const data = await response.json();

        for (const [connId, usage] of Object.entries(data.usage || {})) {
          try {
            await atomicUpdateProviderConnection(connId, (current) => {
              const currentCloudUsage = current?.providerSpecificData?.cloudUsage;
              if (isSameCloudUsage(currentCloudUsage, usage)) {
                return null;
              }

              return {
                providerSpecificData: {
                  ...(current.providerSpecificData || {}),
                  cloudUsage: usage,
                },
              };
            });
          } catch (err) {
            console.error("[CloudUsagePoller] Atomic update failed for", connId, err);
          }
        }

        const duration = Date.now() - startTime;
        if (duration > 3000) {
          console.warn(`[CloudUsagePoller] Slow poll: ${duration}ms`);
        }

        this.lastPollDuration = duration;
        this.lastPollSuccess = true;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.lastPollDuration = duration;
      this.lastPollSuccess = false;

      if (error.name === "AbortError") {
        this.lastError = "Poll timeout after 5s";
        console.warn("[CloudUsagePoller] Timeout after 5s");
      } else {
        this.lastError = `Poll failed: ${error.message}`;
        console.error("[CloudUsagePoller] Failed:", error);
      }
    }
  }

  /**
   * Check if poller is running
   */
  isRunning() {
    return this.intervalId !== null;
  }
}

let usagePoller = null;

export async function getCloudUsagePoller(machineId = null, intervalMs = DEFAULT_CLOUD_USAGE_POLL_INTERVAL_MS) {
  if (!usagePoller || usagePoller.intervalMs !== intervalMs) {
    if (usagePoller?.isRunning()) {
      console.log(`[CloudUsagePoller] Stopping existing poller (interval: ${usagePoller.intervalMs}ms)`);
      usagePoller.stop();
    }
    usagePoller = new CloudUsagePoller(machineId, intervalMs);
  }
  return usagePoller;
}
