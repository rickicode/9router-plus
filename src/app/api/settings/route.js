import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { getQuotaRefreshScheduler } from "@/lib/quotaRefreshScheduler";
import { readRuntimeConfig } from "@/lib/runtimeConfig";
import bcrypt from "bcryptjs";

const DEFAULT_QUOTA_EXHAUSTED_THRESHOLD_PERCENT = 10;
const LEGACY_REMOVED_RESPONSE_KEYS = [
  String.fromCharCode(114, 116, 107, 69, 110, 97, 98, 108, 101, 100),
];

function resolveQuotaExhaustedThresholdPercent(value) {
  if (!Number.isFinite(value)) return DEFAULT_QUOTA_EXHAUSTED_THRESHOLD_PERCENT;
  return Math.min(100, Math.max(0, value));
}

function sanitizeSettingsResponse(settings = {}) {
  const safeSettings = { ...settings };

  delete safeSettings.password;
  for (const legacyKey of LEGACY_REMOVED_RESPONSE_KEYS) {
    delete safeSettings[legacyKey];
  }

  return safeSettings;
}

export async function GET() {
  try {
    const settings = await getSettings();
    const safeSettings = sanitizeSettingsResponse(settings);
    const password = settings?.password;
    const roundRobin = settings?.roundRobin;
    const sticky = settings?.sticky;
    const stickyDuration = settings?.stickyDuration;
    const quotaExhaustedThresholdPercent = resolveQuotaExhaustedThresholdPercent(
      settings?.quotaExhaustedThresholdPercent
    );

    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";

    const runtimeConfig = await readRuntimeConfig();
    const redis = runtimeConfig.redis || {};

    return NextResponse.json({
      ...safeSettings,
      roundRobin,
      sticky,
      stickyDuration,
      quotaExhaustedThresholdPercent,
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password,
      redis: {
        enabled: redis.enabled === true,
        activeServerId: redis.activeServerId || null,
        lastStatus: redis.lastStatus || null,
        server: (redis.servers || []).find((server) => server.id === redis.activeServerId) || null,
      },
    });
  } catch (error) {
    console.error("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const updates = { ...body };
    const currentSettings = body.newPassword || body.morph ? await getSettings() : null;

    // If updating password, hash it
    if (body.newPassword) {
      const currentHash = currentSettings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      updates.password = await bcrypt.hash(body.newPassword, salt);
      delete updates.newPassword;
      delete updates.currentPassword;
    }

    if (body.roundRobin !== undefined) {
      updates.roundRobin = body.roundRobin;
    }
    if (body.sticky !== undefined) {
      updates.sticky = body.sticky;
    }
    if (body.stickyDuration !== undefined) {
      updates.stickyDuration = body.stickyDuration;
    }
    if (body.morph !== undefined) {
      updates.morph = {
        ...(currentSettings?.morph || {}),
        ...(body.morph && typeof body.morph === "object" && !Array.isArray(body.morph)
          ? body.morph
          : {}),
      };
    }

    const settings = await updateSettings(updates);

    // Trigger immediate cloud sync if cloud is enabled
    const { isCloudEnabled } = await import("@/lib/localDb");
    const { syncToCloud } = await import("@/lib/cloudSync");

    if (await isCloudEnabled()) {
      try {
        await syncToCloud();
        console.error("[API] Settings synced to cloud worker");
      } catch (error) {
        console.error("[API] Failed to sync settings to cloud:", error.message);
        // Don't fail the request, sync will retry on schedule
      }
    }

    const shouldRefreshQuotaScheduler = (
      Object.prototype.hasOwnProperty.call(body, "quotaScheduler")
      || Object.prototype.hasOwnProperty.call(body, "quotaExhaustedThresholdPercent")
    );

    if (shouldRefreshQuotaScheduler) {
      await getQuotaRefreshScheduler().refreshSchedule("settings_update");
    }

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    const safeSettings = sanitizeSettingsResponse(settings);
    return NextResponse.json(safeSettings);
  } catch (error) {
    if (error?.message === "Morph base URL must be a valid absolute http(s) URL") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
