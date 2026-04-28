import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { readBackupArtifactFromSettings } from "@/lib/r2BackupClient";

function buildDirectStatus({ runtimeConfigured, backupConfigured, settings, artifactError = null, backupArtifact = null }) {
  if (!runtimeConfigured && !backupConfigured) {
    return {
      state: "idle",
      summary: "Direct R2 not configured.",
    };
  }

  if (runtimeConfigured && !backupConfigured) {
    return {
      state: "runtime-only",
      summary:
        "Runtime publishing is configured, but private R2 backup access is not configured yet.",
    };
  }

  if (backupArtifact?.sqlite?.url || backupArtifact?.sqlite?.key) {
    return {
      state: "ready",
      summary: "Direct R2 configured and backup artifact available.",
    };
  }

  if (settings?.r2LastRuntimePublishAt) {
    return {
      state: "published",
      summary: artifactError
        ? "Direct R2 configured and runtime artifacts were published, but backup artifact is unavailable."
        : "Direct R2 configured and runtime artifacts were published.",
    };
  }

  if (artifactError) {
    return {
      state: "configured",
      summary: "Direct R2 configured, but backup artifact is unavailable.",
    };
  }

  return {
    state: "configured",
    summary: "Direct R2 configured.",
  };
}

function buildBackupArtifactSummary(backupArtifact) {
  if (!backupArtifact || typeof backupArtifact !== "object") return null;

  const sqlite = backupArtifact.sqlite && typeof backupArtifact.sqlite === "object"
    ? backupArtifact.sqlite
    : null;

  return {
    generatedAt: typeof backupArtifact.generatedAt === "string" ? backupArtifact.generatedAt : null,
    machineId: typeof backupArtifact.machineId === "string" ? backupArtifact.machineId : null,
    sqlite: sqlite
      ? {
          key: typeof sqlite.key === "string" ? sqlite.key : null,
          size: Number.isFinite(sqlite.size) ? sqlite.size : null,
        }
      : null,
  };
}

function hasPrivateR2Config(settings = {}) {
  const config = settings.r2Config || {};
  return [config.endpoint, config.bucket, config.accessKeyId, config.secretAccessKey].every(
    (value) => String(value || "").trim() !== ""
  );
}

/**
 * GET /api/r2/info - Get direct R2 publish status for Settings page
 */
export async function GET() {
  try {
    const settings = await getSettings();
    const runtimeConfigured = String(settings.r2RuntimePublicBaseUrl || "").trim() !== "";
    const backupConfigured = hasPrivateR2Config(settings);
    const configured = runtimeConfigured || backupConfigured;

    if (!configured) {
      return NextResponse.json({
        configured: false,
        runtimeConfigured: false,
        backupConfigured: false,
        backupReady: false,
        restoreReady: false,
        r2BackupEnabled: settings.r2BackupEnabled || false,
        r2LastRuntimePublishAt: settings.r2LastRuntimePublishAt || null,
        r2LastBackupAt: settings.r2LastBackupAt || null,
        r2LastRestoreAt: settings.r2LastRestoreAt || null,
        backupArtifactUrl: null,
        backupArtifact: null,
        artifactError: null,
        status: buildDirectStatus({ runtimeConfigured: false, backupConfigured: false, settings }),
      });
    }

    let backupArtifactUrl = null;
    let backupArtifact = null;
    let artifactError = null;

    if (backupConfigured) {
      try {
        const backupArtifactResult = await readBackupArtifactFromSettings({ settings });
        backupArtifactUrl = backupArtifactResult.artifactUrl;
        backupArtifact = backupArtifactResult.artifact;
      } catch (error) {
        artifactError = error?.message || "Failed to read backup artifact";
      }
    }

    const backupReady = backupConfigured && !artifactError;
    const restoreReady =
      backupReady && Boolean(backupArtifact?.sqlite?.url || backupArtifact?.sqlite?.key);

    return NextResponse.json({
      configured: true,
      runtimeConfigured,
      backupConfigured,
      backupReady,
      restoreReady,
      r2BackupEnabled: settings.r2BackupEnabled || false,
      r2LastRuntimePublishAt: settings.r2LastRuntimePublishAt || null,
      r2LastBackupAt: settings.r2LastBackupAt || null,
      r2LastRestoreAt: settings.r2LastRestoreAt || null,
      backupArtifactUrl,
      backupArtifact: buildBackupArtifactSummary(backupArtifact),
      artifactError,
      status: buildDirectStatus({ runtimeConfigured, backupConfigured, settings, artifactError, backupArtifact }),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
