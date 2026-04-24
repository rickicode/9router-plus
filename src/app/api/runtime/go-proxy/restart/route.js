import { NextResponse } from "next/server";
import { goProxyManager } from "@/lib/goProxyManager";
import { restartGoProxyRuntime } from "@/lib/goProxyRuntime";
import { getSettings } from "@/lib/localDb";
import { getInternalProxyTokens } from "@/lib/internalProxyTokens";

export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      // Use defaults if no body
    }

    const settings = await getSettings();
    const tokens = await getInternalProxyTokens();
    
    const config = {
      host: "127.0.0.1",
      port: body.port || settings.goProxyPort || 20138,
      httpTimeoutSeconds: body.httpTimeoutSeconds || settings.goProxyHttpTimeout || 30,
      ninerouterBaseUrl: "http://localhost:20128",
      internalResolveToken: tokens.resolveToken,
      internalReportToken: tokens.reportToken,
      credentialsFile: settings.credentialsFilePath || `${process.env.HOME}/.9router/db.json`,
      binaryPath: `${process.env.HOME}/.9router/bin/9router-go-proxy`,
    };

    const processInfo = goProxyManager.restart(config);
    const runtime = await restartGoProxyRuntime({
      ...config,
      pid: processInfo.pid,
      startedAt: processInfo.startedAt,
    });

    return NextResponse.json(runtime);
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
