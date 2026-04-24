import { NextResponse } from "next/server";
import { goProxyManager } from "@/lib/goProxyManager";
import { getGoProxyRuntimeStatus } from "@/lib/goProxyRuntime";

export async function GET() {
  try {
    const runtimeStatus = getGoProxyRuntimeStatus();
    const managerStatus = goProxyManager.getStatus();
    
    const uptime = runtimeStatus.startedAt 
      ? Math.floor((Date.now() - new Date(runtimeStatus.startedAt).getTime()) / 1000)
      : 0;

    // Fetch request count from usage API
    let requestCount = 0;
    try {
      const usageRes = await fetch("http://localhost:20128/api/usage", {
        signal: AbortSignal.timeout(2000)
      });
      if (usageRes.ok) {
        const usageData = await usageRes.json();
        requestCount = usageData.totalRequests || 0;
      }
    } catch (error) {
      // Ignore usage fetch errors
    }

    // Check health connection to NineRouter
    let health = { connected: false, ninerouterUrl: "http://localhost:20128" };
    if (managerStatus.running) {
      try {
        const healthRes = await fetch("http://localhost:20138/health", {
          signal: AbortSignal.timeout(2000)
        });
        if (healthRes.ok) {
          health.connected = true;
          health.lastCheck = new Date().toISOString();
        }
      } catch (error) {
        // Go Proxy not responding
        health.error = error.message;
      }
    }

    return NextResponse.json({
      ...runtimeStatus,
      ...managerStatus,
      uptime,
      requestCount,
      health,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
