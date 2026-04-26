import { NextResponse } from "next/server";
import { uploadSqliteBackupToAll } from "@/lib/r2BackupClient";
import { updateSettings } from "@/lib/localDb";

/**
 * POST /api/r2/backup - Trigger immediate SQLite backup to R2
 */
export async function POST() {
  try {
    const result = await uploadSqliteBackupToAll();

    if (result.successes > 0) {
      await updateSettings({ r2LastBackupAt: new Date().toISOString() });
    }

    return NextResponse.json({
      success: result.successes > 0,
      ...result
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
