import { NextResponse } from "next/server";

import { getUsageWorkerClient } from "@/lib/usageWorker/client";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const reason = body?.reason && typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "manual_api";
    const mode = body?.mode === "batch" ? "batch" : "all";

    const worker = getUsageWorkerClient();
    const result = mode === "batch"
      ? await worker.runNow(reason)
      : await worker.runAllNow(reason);

    return NextResponse.json({
      success: true,
      reason: result?.timedOut
        ? "run_triggered_status_pending"
        : result?.overrideRequested
          ? "override_requested"
          : result?.queued ? "queued_full_refresh" : "run_triggered",
      requestedReason: reason,
      mode,
      queued: result?.queued === true,
      timedOut: result?.timedOut === true,
      stats: mode === "batch" ? result : null,
      snapshot: result?.status || null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
