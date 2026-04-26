import fs from "node:fs";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getSettings } from "./localDb.js";
import { DB_SQLITE_FILE } from "./sqliteHelpers.js";

const REQUEST_TIMEOUT_MS = 30_000;

function normalizeUrl(url) {
  return String(url || "").replace(/\/$/, "");
}

/**
 * Get R2 config from settings
 */
export async function getR2Config() {
  const settings = await getSettings();
  return settings.r2Config || null;
}

/**
 * Get worker entries with R2 configured
 */
async function getR2WorkerEntries() {
  const settings = await getSettings();
  const cloudUrls = Array.isArray(settings.cloudUrls) ? settings.cloudUrls : [];
  return cloudUrls.filter(c => c?.url && c?.secret);
}

/**
 * Make authenticated request to worker R2 endpoint
 */
async function r2Request(workerUrl, secret, path, options = {}) {
  const url = `${normalizeUrl(workerUrl)}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      "X-Cloud-Secret": secret,
    },
    signal: AbortSignal.timeout(options.timeout || REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* ignore */ }
    throw new Error(`R2 request failed (${res.status}): ${message}`);
  }

  return res;
}

/**
 * Upload SQLite database backup to R2 via worker
 */
export async function uploadSqliteBackup(workerUrl, secret) {
  const machineId = await getConsistentMachineId();

  if (!fs.existsSync(DB_SQLITE_FILE)) {
    throw new Error(`SQLite file not found: ${DB_SQLITE_FILE}`);
  }

  const data = fs.readFileSync(DB_SQLITE_FILE);
  const res = await r2Request(workerUrl, secret, `/r2/backup/sqlite/${machineId}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: data,
    timeout: 60_000,
  });

  return res.json();
}

/**
 * Upload SQLite backup to all configured workers
 */
export async function uploadSqliteBackupToAll() {
  const entries = await getR2WorkerEntries();
  if (entries.length === 0) {
    throw new Error("No cloud workers configured");
  }

  const results = await Promise.allSettled(
    entries.map(entry => uploadSqliteBackup(entry.url, entry.secret))
  );

  const successes = results.filter(r => r.status === "fulfilled").length;
  const failures = results
    .filter(r => r.status === "rejected")
    .map(r => r.reason?.message || "unknown");

  return { successes, failures, total: entries.length };
}

/**
 * List SQLite backups from worker R2
 */
export async function listSqliteBackups(workerUrl, secret) {
  const machineId = await getConsistentMachineId();
  const res = await r2Request(workerUrl, secret, `/r2/backup/sqlite?machineId=${encodeURIComponent(machineId)}`);
  return res.json();
}

/**
 * Download SQLite backup from worker R2
 */
export async function downloadSqliteBackup(workerUrl, secret, backupKey) {
  const machineId = await getConsistentMachineId();
  const params = new URLSearchParams({ machineId, key: backupKey });
  const res = await r2Request(workerUrl, secret, `/r2/backup/sqlite/download?${params}`, {
    timeout: 60_000,
  });
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Upload usage data backup to R2 via worker
 */
export async function uploadUsageBackup(workerUrl, secret, usageData) {
  const machineId = await getConsistentMachineId();
  const res = await r2Request(workerUrl, secret, `/r2/usage/${machineId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(usageData),
  });
  return res.json();
}

/**
 * Upload request logs backup to R2 via worker
 */
export async function uploadRequestLogBackup(workerUrl, secret, requestData) {
  const machineId = await getConsistentMachineId();
  const res = await r2Request(workerUrl, secret, `/r2/requests/${machineId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestData),
  });
  return res.json();
}

/**
 * Export all data from worker R2 (for restore/rollback)
 */
export async function exportFromR2(workerUrl, secret) {
  const machineId = await getConsistentMachineId();
  const res = await r2Request(workerUrl, secret, `/r2/export/${machineId}`);
  return res.json();
}

/**
 * Get R2 storage info from worker
 */
export async function getR2Info(workerUrl, secret) {
  const machineId = await getConsistentMachineId();
  const res = await r2Request(workerUrl, secret, `/r2/info?machineId=${encodeURIComponent(machineId)}`);
  return res.json();
}

/**
 * Restore all data from R2 to local 9Router
 * Downloads the latest SQLite backup and replaces the local database
 */
export async function restoreFromR2(workerUrl, secret) {
  const machineId = await getConsistentMachineId();

  // Get latest backup info
  const backupsRes = await listSqliteBackups(workerUrl, secret);
  const backups = backupsRes?.backups || [];

  if (backups.length === 0) {
    throw new Error("No backups found in R2");
  }

  // Get the most recent backup
  const latestBackup = backups[backups.length - 1];

  // Download the backup
  const backupData = await downloadSqliteBackup(workerUrl, secret, latestBackup.key);

  // Write to data directory
  const backupLocalPath = `${DB_SQLITE_FILE}.pre-restore-${Date.now()}`;

  // Backup current database before restoring
  if (fs.existsSync(DB_SQLITE_FILE)) {
    fs.copyFileSync(DB_SQLITE_FILE, backupLocalPath);
  }

  // Write restored database
  fs.writeFileSync(DB_SQLITE_FILE, backupData);

  // Also export and restore provider data / settings
  const exportData = await exportFromR2(workerUrl, secret);

  return {
    success: true,
    restoredBackup: latestBackup.key,
    backupSize: backupData.length,
    previousBackup: fs.existsSync(backupLocalPath) ? backupLocalPath : null,
    exportData: exportData?.machineData || null,
    restoredAt: new Date().toISOString()
  };
}

/**
 * Backup usage data to all workers periodically
 */
export async function backupUsageToAll(usageData) {
  const entries = await getR2WorkerEntries();
  if (entries.length === 0) return { successes: 0, total: 0 };

  const results = await Promise.allSettled(
    entries.map(entry => uploadUsageBackup(entry.url, entry.secret, usageData))
  );

  return {
    successes: results.filter(r => r.status === "fulfilled").length,
    total: entries.length
  };
}

/**
 * Backup request logs to all workers
 */
export async function backupRequestLogsToAll(requestData) {
  const entries = await getR2WorkerEntries();
  if (entries.length === 0) return { successes: 0, total: 0 };

  const results = await Promise.allSettled(
    entries.map(entry => uploadRequestLogBackup(entry.url, entry.secret, requestData))
  );

  return {
    successes: results.filter(r => r.status === "fulfilled").length,
    total: entries.length
  };
}
