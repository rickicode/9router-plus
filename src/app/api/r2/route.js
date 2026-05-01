import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { registerWithWorker } from "@/lib/cloudWorkerClient";

const VALID_SCHEDULES = ["daily", "weekly", "monthly"];
const R2_CONFIG_STRING_FIELDS = [
  "accountId",
  "accessKeyId",
  "secretAccessKey",
  "bucket",
  "endpoint",
  "region",
  "publicUrl",
];

function validateSchedule(schedule) {
  return typeof schedule === "string" && VALID_SCHEDULES.includes(schedule);
}

function validateRuntimeCacheTtlSeconds(value) {
  return Number.isInteger(value) && value >= 1 && value <= 300;
}

function normalizeRuntimeCacheTtlSeconds(value) {
  return validateRuntimeCacheTtlSeconds(value) ? value : 15;
}

function validateR2ConfigUpdate(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { error: "Invalid r2Config. Expected an object." };
  }

  for (const field of R2_CONFIG_STRING_FIELDS) {
    if (config[field] !== undefined && typeof config[field] !== "string") {
      return { error: `Invalid r2Config.${field}. Expected a string.` };
    }
  }

  return {
    value: {
      accountId: config.accountId || "",
      accessKeyId: config.accessKeyId || "",
      secretAccessKey: config.secretAccessKey || "",
      bucket: config.bucket || "",
      endpoint: config.endpoint || "",
      region: config.region || "",
      publicUrl: config.publicUrl || "",
      connected: false,
      lastCheckedAt: null,
      lastError: "",
    },
  };
}

function shouldRefreshWorkerRegistration(updates) {
  return (
    Object.prototype.hasOwnProperty.call(updates, "r2RuntimePublicBaseUrl") ||
    Object.prototype.hasOwnProperty.call(updates, "r2RuntimeCacheTtlSeconds")
  );
}

function buildWorkerRegistrationMetadata(settings) {
  const runtimeUrl = typeof settings.r2RuntimePublicBaseUrl === "string" ? settings.r2RuntimePublicBaseUrl.trim() : "";
  return {
    ...(runtimeUrl ? { runtimeUrl } : {}),
    cacheTtlSeconds: normalizeRuntimeCacheTtlSeconds(settings.r2RuntimeCacheTtlSeconds),
  };
}

async function refreshRegisteredWorkers(settings) {
  const workers = Array.isArray(settings.cloudUrls) ? settings.cloudUrls : [];
  const metadata = buildWorkerRegistrationMetadata(settings);
  const failures = [];

  for (const worker of workers) {
    if (!worker?.url || !worker?.secret) continue;
    try {
      await registerWithWorker(worker.url, worker.secret, null, metadata);
    } catch (error) {
      const failure = {
        url: worker.url,
        error: error?.message || "Worker registration failed",
      };
      failures.push(failure);
      // Log worker registration failures for monitoring
      console.warn(`[R2] Failed to register worker ${worker.url}:`, error?.message);
    }
  }

  return failures;
}

/**
 * GET /api/r2 - Get R2 backup configuration
 */
export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json({
      r2Config: settings.r2Config,
      r2BackupEnabled: settings.r2BackupEnabled || false,
      r2SqliteBackupSchedule: settings.r2SqliteBackupSchedule || "daily",
      r2AutoPublishEnabled: settings.r2AutoPublishEnabled === true,
      r2RuntimePublicBaseUrl:
        typeof settings.r2RuntimePublicBaseUrl === "string" ? settings.r2RuntimePublicBaseUrl : "",
      r2RuntimeCacheTtlSeconds: normalizeRuntimeCacheTtlSeconds(settings.r2RuntimeCacheTtlSeconds),
      r2LastRuntimePublishAt: settings.r2LastRuntimePublishAt || null,
      r2LastBackupAt: settings.r2LastBackupAt || null,
      r2LastRestoreAt: settings.r2LastRestoreAt || null,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: error?.status || 500 });
  }
}

/**
 * PATCH /api/r2 - Update R2 backup configuration
 */
export async function PATCH(request) {
  try {
    const body = await request.json();
    const currentSettings = await getSettings();
    const updates = {};

    if (body.r2Config !== undefined) {
      const r2ConfigUpdate = validateR2ConfigUpdate(body.r2Config);
      if (r2ConfigUpdate.error) {
        return NextResponse.json({ error: r2ConfigUpdate.error }, { status: 400 });
      }

      updates.r2Config = r2ConfigUpdate.value;
    }

    if (typeof body.r2BackupEnabled === "boolean") {
      updates.r2BackupEnabled = body.r2BackupEnabled;
    }

    if (body.r2SqliteBackupSchedule !== undefined) {
      if (!validateSchedule(body.r2SqliteBackupSchedule)) {
        return NextResponse.json(
          { error: "Invalid R2 backup schedule. Expected one of: daily, weekly, monthly." },
          { status: 400 }
        );
      }

      updates.r2SqliteBackupSchedule = body.r2SqliteBackupSchedule;
    }

    if (body.r2AutoPublishEnabled !== undefined) {
      if (typeof body.r2AutoPublishEnabled !== "boolean") {
        return NextResponse.json(
          { error: "Invalid r2AutoPublishEnabled. Expected a boolean." },
          { status: 400 }
        );
      }

      updates.r2AutoPublishEnabled = body.r2AutoPublishEnabled;
    }

    if (body.r2RuntimePublicBaseUrl !== undefined) {
      if (typeof body.r2RuntimePublicBaseUrl !== "string") {
        return NextResponse.json(
          { error: "Invalid r2RuntimePublicBaseUrl. Expected a string." },
          { status: 400 }
        );
      }

      updates.r2RuntimePublicBaseUrl = body.r2RuntimePublicBaseUrl.trim();
    }

    if (body.r2RuntimeCacheTtlSeconds !== undefined) {
      if (!validateRuntimeCacheTtlSeconds(body.r2RuntimeCacheTtlSeconds)) {
        return NextResponse.json(
          { error: "Invalid r2RuntimeCacheTtlSeconds. Expected an integer between 1 and 300." },
          { status: 400 }
        );
      }

      updates.r2RuntimeCacheTtlSeconds = body.r2RuntimeCacheTtlSeconds;
    }

    const settings = await updateSettings(updates);
    let workerRegistrationFailures = [];

    if (shouldRefreshWorkerRegistration(updates)) {
      workerRegistrationFailures = await refreshRegisteredWorkers(settings);
    }

    const schedulerRelevantChange =
      Object.prototype.hasOwnProperty.call(updates, "r2BackupEnabled") ||
      Object.prototype.hasOwnProperty.call(updates, "r2SqliteBackupSchedule");

    if (schedulerRelevantChange) {
      try {
        const {
          startR2BackupScheduler,
          stopR2BackupScheduler,
          updateSqliteBackupSchedule,
        } = await import("@/lib/r2BackupScheduler");

        if (settings.r2BackupEnabled === true) {
          await startR2BackupScheduler();
          if (updates.r2SqliteBackupSchedule) {
            await updateSqliteBackupSchedule();
          }
        } else {
          stopR2BackupScheduler();
        }
      } catch {
        /* scheduler may be unavailable during tests or startup */
      }
    }

    return NextResponse.json({
      success: true,
      r2Config: settings.r2Config,
      r2BackupEnabled: settings.r2BackupEnabled || false,
      r2SqliteBackupSchedule: settings.r2SqliteBackupSchedule || "daily",
      r2AutoPublishEnabled: settings.r2AutoPublishEnabled === true,
      r2RuntimePublicBaseUrl:
        typeof settings.r2RuntimePublicBaseUrl === "string" ? settings.r2RuntimePublicBaseUrl : "",
      r2RuntimeCacheTtlSeconds: normalizeRuntimeCacheTtlSeconds(settings.r2RuntimeCacheTtlSeconds),
      r2LastRuntimePublishAt: settings.r2LastRuntimePublishAt || null,
      r2LastBackupAt: settings.r2LastBackupAt || null,
      r2LastRestoreAt: settings.r2LastRestoreAt || null,
      ...(workerRegistrationFailures.length > 0 ? { workerRegistrationFailures } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: error?.status || 500 });
  }
}
