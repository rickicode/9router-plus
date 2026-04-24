import { NextResponse } from "next/server";
import { applyProxyOutcomeReport } from "@/lib/usageStatus";

const INTERNAL_AUTH_HEADER = "x-internal-auth";

function hasValidInternalAuth(request) {
  const expectedToken = process.env.INTERNAL_PROXY_REPORT_TOKEN;
  if (!expectedToken) return false;

  const providedToken = request.headers.get(INTERNAL_AUTH_HEADER);
  return Boolean(providedToken) && providedToken === expectedToken;
}

export { applyProxyOutcomeReport };

export async function POST(request) {
  if (!hasValidInternalAuth(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let report;
  try {
    report = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  try {
    await applyProxyOutcomeReport(report);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: "report_ingestion_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
