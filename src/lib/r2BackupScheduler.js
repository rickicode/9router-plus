import { getSettings } from "./localDb.js";
import { uploadSqliteBackupToAll, backupUsageToAll } from "./r2BackupClient.js";

const SQLITE_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const USAGE_BACKUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let sqliteBackupTimer = null;
let usageBackupTimer = null;
let initialized = false;

async function isR2BackupEnabled() {
  try {
    const settings = await getSettings();
    return settings.r2BackupEnabled === true;
  } catch {
    return false;
  }
}

async function runSqliteBackup() {
  if (!await isR2BackupEnabled()) return;

  try {
    const result = await uploadSqliteBackupToAll();
    console.log(`[R2Backup] SQLite backup: ${result.successes}/${result.total} workers OK`);
    if (result.failures.length > 0) {
      console.warn(`[R2Backup] SQLite backup failures:`, result.failures);
    }
  } catch (error) {
    console.error(`[R2Backup] SQLite backup failed:`, error.message);
  }
}

async function runUsageBackup() {
  if (!await isR2BackupEnabled()) return;

  try {
    // Dynamically import to avoid circular deps
    const { getUsageDb } = await import("./usageDb.js");
    const db = await getUsageDb();
    if (!db?.data) return;

    const usageData = {
      dailySummary: db.data.dailySummary || {},
      totalRequestsLifetime: db.data.totalRequestsLifetime || 0,
      backedUpAt: new Date().toISOString()
    };

    const result = await backupUsageToAll(usageData);
    console.log(`[R2Backup] Usage backup: ${result.successes}/${result.total} workers OK`);
  } catch (error) {
    console.error(`[R2Backup] Usage backup failed:`, error.message);
  }
}

export function startR2BackupScheduler() {
  if (initialized) return;
  initialized = true;

  // Initial backup after 2 minutes
  setTimeout(async () => {
    if (await isR2BackupEnabled()) {
      runSqliteBackup();
      runUsageBackup();
    }
  }, 2 * 60 * 1000);

  // Schedule periodic backups
  sqliteBackupTimer = setInterval(runSqliteBackup, SQLITE_BACKUP_INTERVAL_MS);
  usageBackupTimer = setInterval(runUsageBackup, USAGE_BACKUP_INTERVAL_MS);

  console.log("[R2Backup] Scheduler started");
}

export function stopR2BackupScheduler() {
  if (sqliteBackupTimer) {
    clearInterval(sqliteBackupTimer);
    sqliteBackupTimer = null;
  }
  if (usageBackupTimer) {
    clearInterval(usageBackupTimer);
    usageBackupTimer = null;
  }
  initialized = false;
  console.log("[R2Backup] Scheduler stopped");
}

export async function triggerSqliteBackupNow() {
  return runSqliteBackup();
}

export async function triggerUsageBackupNow() {
  return runUsageBackup();
}
