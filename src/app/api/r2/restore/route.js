import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { restoreFromR2, listSqliteBackups, exportFromR2 } from "@/lib/r2BackupClient";

/**
 * GET /api/r2/restore - List available backups for restore
 */
export async function GET() {
  try {
    const settings = await getSettings();
    const cloudUrls = Array.isArray(settings.cloudUrls) ? settings.cloudUrls : [];
    const eligible = cloudUrls.filter(c => c?.url && c?.secret);

    if (eligible.length === 0) {
      return NextResponse.json({ error: "No cloud workers configured" }, { status: 400 });
    }

    const entry = eligible[0];
    const backupsResult = await listSqliteBackups(entry.url, entry.secret);

    return NextResponse.json({
      success: true,
      workerUrl: entry.url,
      workerName: entry.name,
      backups: backupsResult?.backups || []
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/r2/restore - Restore data from R2 backup
 * Body: { workerIndex?: number } - which worker to restore from (default: 0)
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const workerIndex = body.workerIndex || 0;

    const settings = await getSettings();
    const cloudUrls = Array.isArray(settings.cloudUrls) ? settings.cloudUrls : [];
    const eligible = cloudUrls.filter(c => c?.url && c?.secret);

    if (eligible.length === 0) {
      return NextResponse.json({ error: "No cloud workers configured" }, { status: 400 });
    }

    if (workerIndex >= eligible.length) {
      return NextResponse.json({ error: "Invalid worker index" }, { status: 400 });
    }

    const entry = eligible[workerIndex];
    const result = await restoreFromR2(entry.url, entry.secret);

    if (result.success) {
      await updateSettings({ r2LastRestoreAt: new Date().toISOString() });
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
