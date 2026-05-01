import { NextResponse } from "next/server";

import { getUsageWorkerClient } from "@/lib/usageWorker/client";

export async function GET() {
  try {
    const worker = getUsageWorkerClient();
    const status = await worker.getStatus();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
