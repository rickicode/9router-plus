import { NextResponse } from "next/server";
import { goProxyManager } from "@/lib/goProxyManager";
import { startGoProxyRuntime } from "@/lib/goProxyRuntime";
import { getSettings } from "@/lib/localDb";
import { getInternalProxyTokens } from "@/lib/internalProxyTokens";
import fs from "fs";
import path from "path";
import os from "os";

function findGoProxyBinary() {
  const homeDir = os.homedir();
  const candidates = [
    path.join(homeDir, ".9router", "bin", "9router-go-proxy"),
    path.join(process.cwd(), "bin", "9router-go-proxy"),
    path.join(process.cwd(), "go-proxy", "main.go"), // fallback to source
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Go Proxy binary not found. Run: npm run build:go-proxy && npm run install:go-proxy");
}

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
    const binaryPath = findGoProxyBinary();
    const homeDir = os.homedir();
    
    const config = {
      host: "127.0.0.1",
      port: body.port || settings.goProxyPort || 20138,
      httpTimeoutSeconds: body.httpTimeoutSeconds || settings.goProxyHttpTimeout || 30,
      ninerouterBaseUrl: "http://localhost:20128",
      internalResolveToken: tokens.resolveToken,
      internalReportToken: tokens.reportToken,
      credentialsFile: settings.credentialsFilePath || path.join(homeDir, ".9router", "db.json"),
      binaryPath,
    };

    const processInfo = goProxyManager.start(config);
    const runtime = await startGoProxyRuntime({
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
