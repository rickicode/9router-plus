import { NextResponse } from "next/server";
import { publishRuntimeArtifactsFromSettings } from "@/lib/r2BackupClient";

/**
 * POST /api/r2/backup - Trigger immediate SQLite backup to R2
 */
export async function POST() {
  try {
    const result = await publishRuntimeArtifactsFromSettings();

    return NextResponse.json({
      success: result.backup?.ok === true && result.runtime?.ok === true && result.sqlite?.ok === true,
      ...result
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
