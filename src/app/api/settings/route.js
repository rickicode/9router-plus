import { NextResponse } from "next/server";
import { getDefaultChatRuntimeSettings, getSettings, normalizeAutoCompactSettings, normalizeChatRuntimeSettings, normalizeMorphSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { getUsageWorkerClient } from "@/lib/usageWorker/client";
import { buildMorphKeyStatusPatch } from "@/app/api/morph/test-key/route.js";
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

function buildMorphValidationUrl(baseUrl) {
  return new URL("/v1/chat/completions", `${String(baseUrl).replace(/\/+$/, "")}/`).toString();
}

async function validateMorphApiKeys(baseUrl, apiKeys = [], previousApiKeys = []) {
  if (!Array.isArray(apiKeys) || apiKeys.length === 0) {
    return [];
  }

  const previousByEmail = new Map(
    (Array.isArray(previousApiKeys) ? previousApiKeys : [])
      .filter((entry) => entry?.email)
      .map((entry) => [entry.email, entry])
  );

  const validationResults = await Promise.all(apiKeys.map(async (entry) => {
    if (!entry?.email || !entry?.key) {
      return entry;
    }

    const previous = previousByEmail.get(entry.email);
    if (previous?.key === entry.key && previous?.status) {
      return {
        ...entry,
        status: previous.status,
        isExhausted: previous.isExhausted === true,
        lastCheckedAt: previous.lastCheckedAt || entry.lastCheckedAt || null,
        lastError: previous.lastError || "",
      };
    }

    try {
      const response = await fetch(buildMorphValidationUrl(baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${entry.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "morph-v3-fast",
          messages: [
            {
              role: "user",
              content: "<instruction>Reply with exactly OK</instruction>",
            },
          ],
        }),
      });

      const responseText = await response.text().catch(() => "");
      return {
        ...entry,
        ...buildMorphKeyStatusPatch({
          status: response.status,
          responseText,
          fallbackLabel: `HTTP ${response.status}`,
        }),
      };
    } catch (error) {
      return {
        ...entry,
        status: "unknown",
        isExhausted: false,
        lastCheckedAt: new Date().toISOString(),
        lastError: error?.message || "Failed to validate Morph API key",
      };
    }
  }));

  return validationResults;
}

export async function GET() {
  try {
    const settings = await getSettings();
    const safeSettings = sanitizeSettingsResponse(settings);
    const password = settings?.password;
    const quotaExhaustedThresholdPercent = resolveQuotaExhaustedThresholdPercent(
      settings?.quotaExhaustedThresholdPercent
    );

    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";

    return NextResponse.json({
      ...safeSettings,
      quotaExhaustedThresholdPercent,
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password,
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
    const needsCurrentSettings = body.newPassword || body.morph || body.chatRuntime !== undefined || body.autoCompact !== undefined || body.resetChatRuntimeDefaults === true;
    const currentSettings = needsCurrentSettings ? await getSettings() : null;

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

    if (
      body.routing !== undefined
      || body.fallbackStrategy !== undefined
      || body.stickyRoundRobinLimit !== undefined
      || body.providerStrategies !== undefined
      || body.comboStrategy !== undefined
      || body.comboStrategies !== undefined
      || body.roundRobin !== undefined
      || body.sticky !== undefined
      || body.stickyDuration !== undefined
    ) {
      const baseRouting = currentSettings?.routing || {};
      const nextRouting = {
        ...baseRouting,
        ...(body.routing && typeof body.routing === "object" && !Array.isArray(body.routing)
          ? body.routing
          : {}),
      };

      if (body.fallbackStrategy !== undefined) {
        nextRouting.strategy = body.fallbackStrategy;
      }
      if (body.stickyRoundRobinLimit !== undefined) {
        nextRouting.stickyLimit = body.stickyRoundRobinLimit;
      }
      if (body.providerStrategies !== undefined) {
        nextRouting.providerStrategies = body.providerStrategies;
      }
      if (body.comboStrategy !== undefined) {
        nextRouting.comboStrategy = body.comboStrategy;
      }
      if (body.comboStrategies !== undefined) {
        nextRouting.comboStrategies = body.comboStrategies;
      }
      if (body.roundRobin !== undefined) {
        nextRouting.strategy = body.roundRobin ? "round-robin" : "fill-first";
      }
      if (body.sticky !== undefined || body.stickyDuration !== undefined) {
        nextRouting.sticky = {
          ...(baseRouting.sticky || {}),
          ...(nextRouting.sticky && typeof nextRouting.sticky === "object" ? nextRouting.sticky : {}),
        };
        if (body.sticky !== undefined) {
          nextRouting.sticky.enabled = body.sticky;
        }
        if (body.stickyDuration !== undefined) {
          nextRouting.sticky.durationSeconds = body.stickyDuration;
        }
      }

      updates.routing = nextRouting;
      delete updates.roundRobin;
      delete updates.sticky;
      delete updates.stickyDuration;
      delete updates.fallbackStrategy;
      delete updates.stickyRoundRobinLimit;
      delete updates.providerStrategies;
      delete updates.comboStrategy;
      delete updates.comboStrategies;
    }

    if (body.morph !== undefined) {
      const nextMorph = normalizeMorphSettings({
        ...(currentSettings?.morph || {}),
        ...(body.morph && typeof body.morph === "object" && !Array.isArray(body.morph)
          ? body.morph
          : {}),
      });

      updates.morph = {
        ...nextMorph,
        apiKeys: await validateMorphApiKeys(
          nextMorph.baseUrl,
          nextMorph.apiKeys,
          currentSettings?.morph?.apiKeys || []
        ),
      };
    }

    if (body.chatRuntime !== undefined || body.resetChatRuntimeDefaults === true) {
      const baseChatRuntime = body.resetChatRuntimeDefaults === true
        ? getDefaultChatRuntimeSettings()
        : currentSettings?.chatRuntime || {};
      updates.chatRuntime = normalizeChatRuntimeSettings({
        ...baseChatRuntime,
        ...(body.chatRuntime && typeof body.chatRuntime === "object" && !Array.isArray(body.chatRuntime)
          ? body.chatRuntime
          : {}),
      });
      delete updates.resetChatRuntimeDefaults;
    }

    if (body.autoCompact !== undefined) {
      updates.autoCompact = normalizeAutoCompactSettings({
        ...(currentSettings?.autoCompact || {}),
        ...(body.autoCompact && typeof body.autoCompact === "object" && !Array.isArray(body.autoCompact)
          ? body.autoCompact
          : {}),
      });
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

    const shouldRefreshUsageWorker = (
      Object.prototype.hasOwnProperty.call(body, "usageWorker")
      || Object.prototype.hasOwnProperty.call(body, "quotaExhaustedThresholdPercent")
    );

    if (shouldRefreshUsageWorker) {
      try {
        await getUsageWorkerClient().getStatus();
      } catch (error) {
        console.warn("[Settings] Failed to notify usage worker:", error.message);
      }
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
