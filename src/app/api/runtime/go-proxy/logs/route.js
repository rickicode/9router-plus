import { NextResponse } from "next/server";
import { goProxyManager } from "@/lib/goProxyManager";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const lines = parseInt(searchParams.get("lines") || "50", 10);
    
    const logs = goProxyManager.getLogs();
    const recentLogs = logs.slice(-lines);

    return NextResponse.json({ logs: recentLogs });
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
