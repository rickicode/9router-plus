import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { readBackupArtifactFromSettings, restoreFromDirectBackupSettings } from "@/lib/r2BackupClient";

function hasR2Config(settings = {}) {
  const config = settings.r2Config || {};
  return Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey);
}

/**
 * GET /api/r2/restore - List direct R2 restore metadata
 */
export async function GET() {
  try {
    const settings = await getSettings();
    if (!hasR2Config(settings)) {
      return NextResponse.json({ error: "R2 private configuration is not configured" }, { status: 400 });
    }

    const backupArtifactResult = await readBackupArtifactFromSettings({ settings });
    const sqliteEntry = backupArtifactResult.artifact?.sqlite || null;
    const backups = sqliteEntry
      ? [{
          key: sqliteEntry.key || "sqlite/latest.db",
          url: sqliteEntry.url || backupArtifactResult.artifactUrls?.sqliteUrl || null,
          generatedAt: backupArtifactResult.artifact?.generatedAt || null,
          machineId: backupArtifactResult.artifact?.machineId || null,
          size: Number.isFinite(sqliteEntry.size) ? sqliteEntry.size : null,
        }]
      : [];

    return NextResponse.json({
      success: true,
      backupArtifactUrl: backupArtifactResult.artifactUrl,
      backups,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/r2/restore - Restore data from direct R2 backup artifact
 */
export async function POST(request) {
  try {
    await request.json().catch(() => ({}));

    const settings = await getSettings();
    if (!hasR2Config(settings)) {
      return NextResponse.json({ error: "R2 private configuration is not configured" }, { status: 400 });
    }

    const result = await restoreFromDirectBackupSettings({ settings });

    if (result.success) {
      await updateSettings({ r2LastRestoreAt: new Date().toISOString() });
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
