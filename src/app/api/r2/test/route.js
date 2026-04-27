import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { testR2Connection } from "@/lib/r2BackupClient";

const REQUIRED_R2_FIELDS = [
  "accountId",
  "accessKeyId",
  "secretAccessKey",
  "bucket",
  "endpoint",
  "region",
];

function getMissingFields(config) {
  return REQUIRED_R2_FIELDS.filter((field) => String(config?.[field] || "").trim() === "");
}

function buildValidationState(config, overrides) {
  return {
    ...config,
    ...overrides,
  };
}

/**
 * POST /api/r2/test - Validate the configured global R2 connection and persist status.
 */
export async function POST() {
  const settings = await getSettings();
  const currentConfig = settings.r2Config || {};
  const missingFields = getMissingFields(currentConfig);
  const checkedAt = new Date().toISOString();

  if (missingFields.length > 0) {
    const error = `Missing required R2 configuration fields: ${missingFields.join(", ")}`;
    await updateSettings({
      r2Config: buildValidationState(currentConfig, {
        connected: false,
        lastCheckedAt: checkedAt,
        lastError: error,
      }),
    });

    return NextResponse.json(
      {
        success: false,
        error,
      },
      { status: 400 }
    );
  }

  try {
    await testR2Connection(currentConfig);

    const nextConfig = buildValidationState(currentConfig, {
      connected: true,
      lastCheckedAt: checkedAt,
      lastError: "",
    });
    const updatedSettings = await updateSettings({ r2Config: nextConfig });

    return NextResponse.json({
      success: true,
      r2Config: updatedSettings.r2Config,
    });
  } catch (error) {
    const nextConfig = buildValidationState(currentConfig, {
      connected: false,
      lastCheckedAt: checkedAt,
      lastError: error.message,
    });
    await updateSettings({ r2Config: nextConfig });

    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
}
