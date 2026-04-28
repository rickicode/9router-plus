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
      restoreMode: "latest-only",
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
    const body = await request.json().catch(() => ({}));

    const settings = await getSettings();
    if (!hasR2Config(settings)) {
      return NextResponse.json({ error: "R2 private configuration is not configured" }, { status: 400 });
    }

    const backupArtifactResult = await readBackupArtifactFromSettings({ settings });
    const sqliteEntry = backupArtifactResult.artifact?.sqlite || null;
    const restoreKey = sqliteEntry?.key || "sqlite/latest.db";

    if (!sqliteEntry) {
      return NextResponse.json({ error: "No SQLite backup is available to restore" }, { status: 400 });
    }

    if (body?.confirmRestore !== true) {
      return NextResponse.json(
        {
          error: "Restore requires explicit confirmation",
          requiresConfirmation: true,
          backup: {
            key: restoreKey,
            generatedAt: backupArtifactResult.artifact?.generatedAt || null,
            machineId: backupArtifactResult.artifact?.machineId || null,
            size: Number.isFinite(sqliteEntry.size) ? sqliteEntry.size : null,
          },
        },
        { status: 400 }
      );
    }

    if (body?.key && body.key !== restoreKey) {
      return NextResponse.json(
        {
          error: "Restore target no longer matches the latest available backup",
          expectedKey: restoreKey,
        },
        { status: 409 }
      );
    }

    const result = await restoreFromDirectBackupSettings({ settings });

    if (result.success) {
      await updateSettings({ r2LastRestoreAt: new Date().toISOString() });
    }

    return NextResponse.json({
      ...result,
      restoredBackup: {
        key: restoreKey,
        generatedAt: backupArtifactResult.artifact?.generatedAt || null,
        machineId: backupArtifactResult.artifact?.machineId || null,
        size: Number.isFinite(sqliteEntry.size) ? sqliteEntry.size : null,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
