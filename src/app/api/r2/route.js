import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";

const VALID_SCHEDULES = ["daily", "weekly", "monthly"];

/**
 * GET /api/r2 - Get R2 backup configuration
 */
export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json({
      r2BackupEnabled: settings.r2BackupEnabled || false,
      r2SqliteBackupSchedule: settings.r2SqliteBackupSchedule || "daily",
      r2LastBackupAt: settings.r2LastBackupAt || null,
      r2LastRestoreAt: settings.r2LastRestoreAt || null,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * PATCH /api/r2 - Update R2 backup configuration
 */
export async function PATCH(request) {
  try {
    const body = await request.json();
    const updates = {};

    if (typeof body.r2BackupEnabled === "boolean") {
      updates.r2BackupEnabled = body.r2BackupEnabled;
    }

    if (typeof body.r2SqliteBackupSchedule === "string" && VALID_SCHEDULES.includes(body.r2SqliteBackupSchedule)) {
      updates.r2SqliteBackupSchedule = body.r2SqliteBackupSchedule;
    }

    const settings = await updateSettings(updates);

    // Re-schedule the backup timer if schedule changed
    if (updates.r2SqliteBackupSchedule) {
      try {
        const { updateSqliteBackupSchedule } = await import("@/lib/r2BackupScheduler");
        await updateSqliteBackupSchedule();
      } catch { /* scheduler may not be running */ }
    }

    return NextResponse.json({
      success: true,
      r2BackupEnabled: settings.r2BackupEnabled || false,
      r2SqliteBackupSchedule: settings.r2SqliteBackupSchedule || "daily",
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
