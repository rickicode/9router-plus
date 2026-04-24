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

    // Check health connection to NineRouter with latency
    let health = { connected: false, ninerouterUrl: "http://localhost:20128", latency: null };
    if (managerStatus.running) {
      const healthCheck = await goProxyManager.checkHealthWithLatency(runtimeStatus.port || 20138);
      health.connected = healthCheck.ok;
      health.latency = healthCheck.latency;
      health.lastCheck = new Date().toISOString();
      if (healthCheck.error) {
        health.error = healthCheck.error;
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
