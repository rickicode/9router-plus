import { NextResponse } from "next/server";
import { getMorphUsageStats } from "@/lib/morphUsageDb.js";
import { logMorphApiAccess } from "@/app/api/morph/_shared.js";

const VALID_PERIODS = new Set(["24h", "7d", "30d", "60d", "all"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  logMorphApiAccess(request);
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const stats = await getMorphUsageStats(period);
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get Morph usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch Morph usage stats" }, { status: 500 });
  }
}
