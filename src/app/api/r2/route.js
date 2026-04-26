import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";

/**
 * GET /api/r2 - Get R2 backup configuration
 */
export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json({
      r2BackupEnabled: settings.r2BackupEnabled || false,
      r2BackupIntervalHours: settings.r2BackupIntervalHours || 6,
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

    if (typeof body.r2BackupIntervalHours === "number") {
      updates.r2BackupIntervalHours = Math.max(1, Math.min(24, body.r2BackupIntervalHours));
    }

    const settings = await updateSettings(updates);
    return NextResponse.json({
      success: true,
      r2BackupEnabled: settings.r2BackupEnabled || false,
      r2BackupIntervalHours: settings.r2BackupIntervalHours || 6,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
