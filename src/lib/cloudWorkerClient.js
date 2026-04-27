import crypto from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const REQUEST_TIMEOUT_MS = 8_000;

function normalizeUrl(url) {
  return String(url || "").replace(/\/$/, "");
}

/**
 * Generate a 32-byte hex shared secret used to authenticate the web app to
 * its cloud worker.
 */
export function generateCloudSecret() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Probe the worker's public liveness endpoint.
 * Does NOT require a secret. Returns latency + worker version when reachable.
 */
export async function probeCloudHealth(workerUrl) {
  const url = `${normalizeUrl(workerUrl)}/admin/health`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, status: "error", latencyMs, error: `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => ({}));
    return {
      ok: true,
      status: "online",
      latencyMs,
      version: body?.version || null,
      uptime: body?.uptime ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      status: "offline",
      latencyMs: Date.now() - startedAt,
      error: error?.name === "AbortError" ? "timeout" : (error?.message || "fetch failed"),
    };
  }
}

/**
 * Register this machineId + secret with the worker. The worker rejects the
 * request if the machineId already has a different secret stored — preventing
 * silent hijacking of an existing record.
 */
export async function registerWithWorker(workerUrl, secret, machineId, metadata = {}) {
  const mid = machineId || (await getConsistentMachineId());
  const url = `${normalizeUrl(workerUrl)}/admin/register`;
  const payload = {
    machineId: mid,
    secret,
  };

  if (metadata.runtimeUrl) payload.runtimeUrl = metadata.runtimeUrl;
  if (Number.isFinite(metadata.cacheTtlSeconds)) {
    payload.cacheTtlSeconds = metadata.cacheTtlSeconds;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }

  if (!res.ok) {
    const message = body?.error || `register failed (HTTP ${res.status})`;
    throw new Error(message);
  }

  return body || {};
}

/**
 * Fetch the JSON status payload for this machineId from the worker.
 * Used by the dashboard to render sync state without exposing the secret to
 * the browser.
 */
export async function fetchWorkerStatus(workerUrl, secret, machineId) {
  const mid = machineId || (await getConsistentMachineId());
  const url = `${normalizeUrl(workerUrl)}/admin/status.json?machineId=${encodeURIComponent(mid)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { "X-Cloud-Secret": secret },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }

  if (!res.ok) {
    const message = body?.error || `status fetch failed (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return body;
}

/**
 * Build the URL the user can open in a browser tab to view the live worker
 * dashboard. The token is included in the query string because the dashboard
 * is server-rendered HTML and the user is following a click from the trusted
 * 9Router web UI.
 */
export function buildWorkerDashboardUrl(workerUrl, secret, machineId) {
  const base = normalizeUrl(workerUrl);
  const params = new URLSearchParams({
    machineId,
    token: secret,
  });
  return `${base}/admin/status?${params.toString()}`;
}
