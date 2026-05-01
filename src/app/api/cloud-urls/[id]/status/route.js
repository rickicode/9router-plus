import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import {
  fetchWorkerStatus,
  probeCloudHealth,
  buildWorkerDashboardUrl,
} from "@/lib/cloudWorkerClient";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { hasValidCloudRouteOrigin } from "@/lib/cloudRequestAuth";

function maskSecret(secret) {
  if (typeof secret !== "string" || secret.length < 12) return "••••";
  return `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}

function shouldRevealSecret(request) {
  const includeSecret = request.nextUrl?.searchParams?.get("includeSecret");
  if (includeSecret != null) return includeSecret === "1";

  try {
    return new URL(request.url).searchParams.get("includeSecret") === "1";
  } catch {
    return false;
  }
}

/**
 * GET /api/cloud-urls/:id/status
 *
 * Returns the live state of a registered cloud worker:
 *   - liveness probe (latency, version, uptime)
 *   - synced view (providers, sync stats) if the worker recognises us
 *   - a one-shot signed dashboard URL the user can open in a new tab
 *
 * The shared secret is held server-side and never returned to the browser
 * directly. The dashboard URL DOES embed the token because the worker's
 * `/admin/status` page is server-rendered HTML — but it is short-lived in the
 * sense that rotating the secret (TODO: future work) immediately invalidates
 * the link.
 */
export async function GET(request, context) {
  if (!hasValidCloudRouteOrigin(request)) {
    return NextResponse.json({ error: "CSRF validation failed" }, { status: 403 });
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "Missing cloud URL id" }, { status: 400 });
  }

  const settings = await getSettings();
  const entry = (settings.cloudUrls || []).find((c) => c.id === id);
  if (!entry) {
    return NextResponse.json({ error: "Cloud URL not found" }, { status: 404 });
  }

  if (!entry.url) {
    return NextResponse.json({ error: "Cloud URL has no URL configured" }, { status: 400 });
  }

  const machineId = await getConsistentMachineId();
  const probe = await probeCloudHealth(entry.url);

  if (!entry.secret) {
    return NextResponse.json({
      reachable: probe.ok,
      probe,
      registered: false,
      machineId,
      lastSyncAt: entry.lastSyncAt || null,
      lastSyncOk: entry.lastSyncOk ?? null,
      providersCount: entry.providersCount ?? null,
      url: entry.url,
      hasSecret: false,
      secretMasked: null,
      message: "Worker not registered yet. Re-add the cloud URL to register.",
    });
  }

  let workerStatus = null;
  let workerError = null;
  let workerStatusCode = null;

  if (probe.ok) {
    try {
      workerStatus = await fetchWorkerStatus(entry.url, entry.secret, machineId);
    } catch (error) {
      workerError = error.message || "status fetch failed";
      workerStatusCode = error.status || null;
    }
  }

  return NextResponse.json({
    reachable: probe.ok,
    probe,
    registered: true,
    machineId,
    url: entry.url,
    name: entry.name || null,
    lastSyncAt: entry.lastSyncAt || workerStatus?.lastSyncAt || null,
    lastSyncOk: entry.lastSyncOk ?? null,
    lastSyncError: entry.lastSyncError || null,
    providersCount: workerStatus?.counts?.providers ?? entry.providersCount ?? null,
    workerStatus,
    workerError,
    workerStatusCode,
    hasSecret: true,
    secretMasked: maskSecret(entry.secret),
    secret: shouldRevealSecret(request) ? entry.secret : undefined,
    dashboardUrl: buildWorkerDashboardUrl(entry.url, entry.secret, machineId),
  });
}
