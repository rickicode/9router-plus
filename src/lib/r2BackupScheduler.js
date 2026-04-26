import { getSettings } from "./localDb.js";
import { uploadSqliteBackupToAll, backupUsageToAll } from "./r2BackupClient.js";

const SCHEDULE_INTERVALS_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};
const USAGE_BACKUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let sqliteBackupTimer = null;
let usageBackupTimer = null;
let currentSchedule = null;
let initialized = false;

async function isR2BackupEnabled() {
  try {
    const settings = await getSettings();
    return settings.r2BackupEnabled === true;
  } catch {
    return false;
  }
}

async function getSqliteBackupIntervalMs() {
  try {
    const settings = await getSettings();
    const schedule = settings.r2SqliteBackupSchedule || "daily";
    return SCHEDULE_INTERVALS_MS[schedule] || SCHEDULE_INTERVALS_MS.daily;
  } catch {
    return SCHEDULE_INTERVALS_MS.daily;
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

function clearSqliteTimer() {
  if (sqliteBackupTimer) {
    clearInterval(sqliteBackupTimer);
    sqliteBackupTimer = null;
  }
}

async function scheduleSqliteBackup() {
  clearSqliteTimer();
  const intervalMs = await getSqliteBackupIntervalMs();
  sqliteBackupTimer = setInterval(runSqliteBackup, intervalMs);

  const settings = await getSettings().catch(() => ({}));
  currentSchedule = settings.r2SqliteBackupSchedule || "daily";
  console.log(`[R2Backup] SQLite backup scheduled: ${currentSchedule} (${intervalMs / 3600000}h)`);
}

export async function startR2BackupScheduler() {
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
  await scheduleSqliteBackup();
  usageBackupTimer = setInterval(runUsageBackup, USAGE_BACKUP_INTERVAL_MS);

  console.log("[R2Backup] Scheduler started");
}

export function stopR2BackupScheduler() {
  clearSqliteTimer();
  if (usageBackupTimer) {
    clearInterval(usageBackupTimer);
    usageBackupTimer = null;
  }
  initialized = false;
  currentSchedule = null;
  console.log("[R2Backup] Scheduler stopped");
}

/**
 * Call after changing the schedule setting to re-schedule the timer.
 */
export async function updateSqliteBackupSchedule() {
  if (!initialized) return;
  await scheduleSqliteBackup();
}

export async function triggerSqliteBackupNow() {
  return runSqliteBackup();
}

export async function triggerUsageBackupNow() {
  return runUsageBackup();
}
