import { NextResponse } from "next/server";

function normalizeUrl(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/$/, "");
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const url = normalizeUrl(body?.url);

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    if (!isValidHttpUrl(url)) {
      return NextResponse.json({ error: "URL must be a valid HTTP or HTTPS address" }, { status: 400 });
    }

    const startedAt = Date.now();
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - startedAt;

    return NextResponse.json({
      success: response.ok,
      status: response.ok ? "online" : "offline",
      latency,
      statusCode: response.status,
    });
  } catch (error) {
    const isCors = error.message?.includes("CORS") || error.name === "TypeError";
    return NextResponse.json({
      success: false,
      status: "error",
      latency: null,
      error: error.name === "TimeoutError"
        ? "Request timed out"
        : (isCors ? "CORS error - check worker configuration" : (error.message || "Health check failed")),
    }, { status: 503 });
  }
}
