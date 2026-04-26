import { NextResponse } from "next/server";
import { syncToCloud } from "@/lib/cloudSync";

/**
 * POST /api/cloud-urls/sync
 *
 * Manually trigger a sync to all registered cloud workers. Used by the
 * "Sync now" button in the dashboard.
 */
export async function POST() {
  try {
    const result = await syncToCloud();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Cloud sync failed" },
      { status: 500 }
    );
  }
}
