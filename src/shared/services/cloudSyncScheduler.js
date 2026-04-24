import { getConsistentMachineId } from "@/shared/utils/machineId";
import { isCloudEnabled } from "@/lib/localDb";
import { syncToCloud } from "@/lib/cloudSync";

/**
 * Cloud sync scheduler
 */
export class CloudSyncScheduler {
  constructor(machineId = null, intervalMinutes = 15) {
    this.machineId = machineId;
    this.intervalMinutes = intervalMinutes;
    this.intervalId = null;
  }

  /**
   * Initialize machine ID if not provided
   */
  async initializeMachineId() {
    if (!this.machineId) {
      this.machineId = await getConsistentMachineId();
    }
  }

  /**
   * Start periodic sync (delays first sync to allow server to be ready)
   */
  async start() {
    if (this.intervalId) {
      return;
    }

    await this.initializeMachineId();
    
    // Delay first sync by 5 seconds to ensure server is ready
    setTimeout(() => {
      this.syncWithRetry().catch(() => {});
    }, 5000);
    
    // Then sync periodically
    this.intervalId = setInterval(() => {
      this.syncWithRetry().catch(() => {});
    }, this.intervalMinutes * 60 * 1000);
  }

  /**
   * Stop periodic sync
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Sync with retry logic (exponential backoff)
   */
  async syncWithRetry(maxRetries = 1) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.sync();
        return result;
      } catch (error) {
        if (attempt === maxRetries) {
          return null;
        }
        
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000); // Max 10s
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Perform sync via cloud sync module
   */
  async sync() {
    const enabled = await isCloudEnabled();
    if (!enabled) {
      return null;
    }

    await this.initializeMachineId();

    try {
      const result = await syncToCloud();
      return result;
    } catch (error) {
      throw new Error(error.message || "Sync failed");
    }
  }

  /**
   * Check if scheduler is running
   */
  isRunning() {
    return this.intervalId !== null;
  }
}

// Export a singleton instance if needed
let cloudSyncScheduler = null;

export async function getCloudSyncScheduler(machineId = null, intervalMinutes = 15) {
  if (!cloudSyncScheduler) {
    cloudSyncScheduler = new CloudSyncScheduler(machineId, intervalMinutes);
  }
  return cloudSyncScheduler;
}
