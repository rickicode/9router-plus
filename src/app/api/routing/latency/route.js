import { NextResponse } from "next/server";
import { getRoutingLatencySummary } from "@/lib/routingLatency";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const windowMs = Number.parseInt(url.searchParams.get("windowMs") || "", 10);
    const summary = getRoutingLatencySummary({
      windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : undefined,
    });
    return NextResponse.json(summary, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to read routing latency", message: error?.message || String(error) },
      { status: 500 },
    );
  }
}
