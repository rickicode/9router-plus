import { NextResponse } from "next/server";
import { getPluginUsageSummary, getUsageDb } from "@/lib/usageDb.js";

const VALID_PERIODS = new Set(["today", "last24h", "7d"]);

export async function GET(request) {
  try {
    const url = request?.url ? new URL(request.url) : new URL("http://localhost");
    const period = url.searchParams.get("period") || "today";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json(
        { ok: false, error: "Invalid period" },
        { status: 400 },
      );
    }

    const db = await getUsageDb();
    const now = new Date();
    const history = Array.isArray(db.data?.history) ? db.data.history : [];
    const dailySummary =
      db.data?.dailySummary &&
      typeof db.data.dailySummary === "object" &&
      !Array.isArray(db.data.dailySummary)
        ? db.data.dailySummary
        : {};
    const summary = getPluginUsageSummary({
      period,
      history,
      dailySummary,
      now,
    });

    return NextResponse.json({
      ok: true,
      period,
      generatedAt: now.toISOString(),
      summary,
    });
  } catch (error) {
    console.error("[API] Failed to fetch plugin usage summary:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to fetch plugin usage summary" },
      { status: 500 },
    );
  }
}
