import { NextResponse } from "next/server";
import { goProxyManager } from "@/lib/goProxyManager";
import { stopGoProxyRuntime } from "@/lib/goProxyRuntime";

export async function POST() {
  try {
    goProxyManager.stop();
    const runtime = await stopGoProxyRuntime();
    return NextResponse.json(runtime);
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
