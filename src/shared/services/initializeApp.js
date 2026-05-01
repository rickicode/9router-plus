import { cleanupProviderConnections, getSettings, updateSettings, getApiKeys, isCloudEnabled } from "@/lib/localDb";
import { getUsageWorkerClient } from "@/lib/usageWorker/client";
import { closeSqliteDb } from "@/lib/sqliteHelpers";
import { enableTunnel, isTunnelManuallyDisabled, isTunnelReconnecting } from "@/lib/tunnel/tunnelManager";
import { killCloudflared, isCloudflaredRunning, ensureCloudflared } from "@/lib/tunnel/cloudflared";
import { getCloudUsagePoller } from "@/shared/services/cloudUsagePoller";
import * as mitmManager from "@/mitm/manager";

const { getMitmStatus, startMitm, loadEncryptedPassword, initDbHooks } = mitmManager;
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";

import os from "os";

// Inject correct paths and DB hooks into manager.js (CJS) from ESM context.
// Must run before any MITM function is called.
(function bootstrapMitm() {
  // 1. Resolve server.js path from real ESM __filename (not bundled path)
  if (!process.env.MITM_SERVER_PATH) {
    try {
      const thisFile = fileURLToPath(import.meta.url);
      const appSrc = dirname(dirname(thisFile)); // src/
      const candidate = join(appSrc, "mitm", "server.js");
      if (existsSync(candidate)) {
        process.env.MITM_SERVER_PATH = candidate;
      }
    } catch { /* ignore */ }
  }

  // 2. Inject DB functions so manager.js (CJS) can save/load settings
  //    without dynamic import issues inside webpack bundles
  try {
    initDbHooks(getSettings, updateSettings);
  } catch { /* ignore */ }
})();

// Multiple modules register SIGINT/SIGTERM handlers legitimately
process.setMaxListeners(20);

// Use global to survive Next.js hot reload — prevents duplicate intervals
const g = global.__appSingleton ??= {
  signalHandlersRegistered: false,
  watchdogInterval: null,
  networkMonitorInterval: null,
  lastNetworkFingerprint: null,
  lastWatchdogTick: Date.now(),
  lastTunnelRestartAt: 0,
  tunnelRestartInProgress: false,
  mitmStartInProgress: false,
};

const WATCHDOG_INTERVAL_MS = 60000;
const NETWORK_CHECK_INTERVAL_MS = 5000;
const NETWORK_RESTART_COOLDOWN_MS = 30000;

/**
 * Initialize app on startup
 * - Cleanup stale data
 * - Auto-reconnect tunnel if previously enabled
 * - Register shutdown handler to kill cloudflared
 * - Start watchdog to recover tunnel after sleep/wake
 */
export async function initializeApp() {
  try {
    await cleanupProviderConnections();

    // Auto-reconnect tunnel if it was enabled before restart
    const settings = await getSettings();
    if (settings.tunnelEnabled && !isCloudflaredRunning()) {
      console.log("[InitApp] Tunnel was enabled, auto-reconnecting...");
      try {
        await enableTunnel();
        console.log("[InitApp] Tunnel reconnected");
      } catch (error) {
        console.log("[InitApp] Tunnel reconnect failed:", error.message);
      }
    }

    // Kill cloudflared and close SQLite (checkpoint WAL) on process exit
    // (register once only). Closing SQLite cleanly is what prevents the WAL
    // file from growing unbounded across restarts (M2).
    if (!g.signalHandlersRegistered) {
      const cleanup = () => {
        try {
          killCloudflared();
        } catch { /* ignore */ }
        try {
          closeSqliteDb();
        } catch { /* ignore */ }
        process.exit();
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      g.signalHandlersRegistered = true;
    }

    // Pre-download cloudflared binary in background
    ensureCloudflared().catch(() => {});

    // Watchdog: recover tunnel after process crash
    startWatchdog();

    // Network monitor: detect sleep/wake + network changes → restart tunnel
    startNetworkMonitor();

    // Start usage worker in a standalone process so background usage checks do not contend with request handling.
    getUsageWorkerClient().start().catch((error) => {
      console.error("[InitApp] Failed to start usage worker:", error);
    });

    // Start cloud usage poller if enabled
    if (await isCloudEnabled()) {
      const usagePoller = await getCloudUsagePoller();
      await usagePoller.start();
      console.log('[INIT] Cloud usage poller started');
    }

    // Start cloud sync scheduler if enabled
    if (await isCloudEnabled()) {
      try {
        const { getCloudSyncScheduler } = await import("@/shared/services/cloudSyncScheduler");
        const syncScheduler = await getCloudSyncScheduler();
        await syncScheduler.start();
        console.log('[INIT] Cloud sync scheduler started (15 min interval)');
      } catch (error) {
        console.error('[INIT] Failed to start cloud sync scheduler:', error);
      }
    }

    // Start R2 backup scheduler only when scheduled backups are enabled.
    if (settings.r2BackupEnabled) {
      try {
        const { startR2BackupScheduler } = await import("@/lib/r2BackupScheduler");
        startR2BackupScheduler();
        console.log('[INIT] R2 backup scheduler started');
      } catch (error) {
        console.error('[INIT] Failed to start R2 backup scheduler:', error);
      }
    }

    // Auto-start MITM if it was enabled before restart
    autoStartMitm();
  } catch (error) {
    console.error("[InitApp] Error:", error);
  }
}

/** Auto-start MITM if it was enabled before restart */
async function autoStartMitm() {
  if (g.mitmStartInProgress) return;
  g.mitmStartInProgress = true;
  try {
    const settings = await getSettings();
    if (!settings.mitmEnabled) return;

    const mitmStatus = await getMitmStatus();
    if (mitmStatus.running) return;

    const password = await loadEncryptedPassword();
    if (!password && process.platform !== "win32") {
      console.log("[InitApp] MITM was enabled but no saved password found, skipping auto-start");
      return;
    }

    // Need an active API key
    const keys = await getApiKeys();
    const activeKey = keys.find(k => k.isActive !== false);

    console.log("[InitApp] MITM was enabled, auto-starting...");
    await startMitm(activeKey?.key || "sk_9router", password);
    console.log("[InitApp] MITM auto-started");
  } catch (err) {
    console.log("[InitApp] MITM auto-start failed:", err.message);
  } finally {
    g.mitmStartInProgress = false;
  }
}

/** Periodically check tunnel process health and reconnect if crashed */
function startWatchdog() {
  if (g.watchdogInterval) return;
  g.watchdogInterval = setInterval(async () => {
    try {
      if (isTunnelManuallyDisabled()) return;
      if (isTunnelReconnecting()) return;
      if (g.tunnelRestartInProgress) return;
      const settings = await getSettings();
      if (!settings.tunnelEnabled) return;
      if (isCloudflaredRunning()) return;
      console.log("[Watchdog] Tunnel process is down, attempting recovery...");
      g.tunnelRestartInProgress = true;
      try {
        await enableTunnel();
        console.log("[Watchdog] Tunnel recovered");
      } finally {
        g.tunnelRestartInProgress = false;
      }
    } catch (err) {
      console.log("[Watchdog] Recovery failed:", err.message);
    }
  }, WATCHDOG_INTERVAL_MS);

  if (g.watchdogInterval.unref) g.watchdogInterval.unref();
}

/** Get network fingerprint from active interfaces (IPv4 only) */
function getNetworkFingerprint() {
  const interfaces = os.networkInterfaces();
  const active = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (!addr.internal && addr.family === "IPv4") {
        active.push(`${name}:${addr.address}`);
      }
    }
  }
  return active.sort().join("|");
}

/** Monitor network changes + sleep/wake → kill and reconnect tunnel */
function startNetworkMonitor() {
  if (g.networkMonitorInterval) return;

  g.lastNetworkFingerprint = getNetworkFingerprint();
  g.lastWatchdogTick = Date.now();

  g.networkMonitorInterval = setInterval(async () => {
    try {
      if (isTunnelManuallyDisabled()) return;
      const settings = await getSettings();
      if (!settings.tunnelEnabled) return;

      const now = Date.now();
      const elapsed = now - g.lastWatchdogTick;
      g.lastWatchdogTick = now;

      const currentFingerprint = getNetworkFingerprint();
      const networkChanged = currentFingerprint !== g.lastNetworkFingerprint;
      const wasSleep = elapsed > NETWORK_CHECK_INTERVAL_MS * 3;

      if (networkChanged) g.lastNetworkFingerprint = currentFingerprint;

      if (!networkChanged && !wasSleep) return;

      // Skip if restart already in progress or restarted recently
      if (g.tunnelRestartInProgress) return;
      if (isTunnelReconnecting()) return;
      if (now - g.lastTunnelRestartAt < NETWORK_RESTART_COOLDOWN_MS) return;

      const reason = wasSleep && networkChanged ? "sleep/wake + network change"
        : wasSleep ? "sleep/wake" : "network change";
      console.log(`[NetworkMonitor] ${reason} detected, restarting tunnel...`);

      g.tunnelRestartInProgress = true;
      g.lastTunnelRestartAt = now;
      try {
        killCloudflared();
        await new Promise(r => setTimeout(r, 2000));
        await enableTunnel();
        console.log("[NetworkMonitor] Tunnel restarted");
        g.lastNetworkFingerprint = getNetworkFingerprint();
      } finally {
        g.tunnelRestartInProgress = false;
      }
    } catch (err) {
      console.log("[NetworkMonitor] Tunnel restart failed:", err.message);
    }
  }, NETWORK_CHECK_INTERVAL_MS);

  if (g.networkMonitorInterval.unref) g.networkMonitorInterval.unref();
}

export default initializeApp;
