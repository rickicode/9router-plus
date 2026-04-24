import { NextResponse } from "next/server";
import { setGoProxyRuntimePort } from "@/lib/goProxyRuntime";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const runtime = setGoProxyRuntimePort(body?.port ?? null);
  return NextResponse.json(runtime);
}
