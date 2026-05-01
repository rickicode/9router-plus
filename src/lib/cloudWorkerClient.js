import crypto from "node:crypto";

const REQUEST_TIMEOUT_MS = 8_000;

function normalizeUrl(url) {
  return String(url || "").replace(/\/$/, "");
}

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
 * Validate that the configured shared secret is accepted by the worker and
 * optionally refresh runtime metadata.
 */
export async function registerWithWorker(workerUrl, secret, metadata = {}) {
  const url = `${normalizeUrl(workerUrl)}/admin/register`;
  const payload = {};

  if (metadata.runtimeUrl) payload.runtimeUrl = metadata.runtimeUrl;
  if (Number.isFinite(metadata.cacheTtlSeconds)) {
    payload.cacheTtlSeconds = metadata.cacheTtlSeconds;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cloud-Secret": secret,
    },
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
 * Fetch the JSON status payload for this worker.
 * Used by the dashboard to render sync state without exposing the secret to
 * the browser.
 */
export async function fetchWorkerStatus(workerUrl, secret) {
  const url = `${normalizeUrl(workerUrl)}/admin/status.json`;
  const startedAt = Date.now();

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

  return {
    ...(body || {}),
    latencyMs: Date.now() - startedAt,
  };
}

export async function refreshWorkerRuntime(workerUrl, secret) {
  const url = `${normalizeUrl(workerUrl)}/admin/runtime/refresh`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cloud-Secret": secret,
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }

  if (!res.ok) {
    const message = body?.error || `runtime refresh failed (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return body || {};
}

export async function unregisterWorker(workerUrl, secret) {
  const url = `${normalizeUrl(workerUrl)}/admin/unregister`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cloud-Secret": secret,
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }

  if (!res.ok) {
    const message = body?.error || `unregister failed (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return body || {};
}

export async function fetchWorkerUsageEvents(workerUrl, secret, { machineId, cursor = 0, limit = 500 } = {}) {
  const params = new URLSearchParams({
    machineId: String(machineId || "").trim(),
    cursor: String(Number(cursor) || 0),
    limit: String(Number(limit) || 500),
  });
  const url = `${normalizeUrl(workerUrl)}/admin/usage/events?${params}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { "X-Cloud-Secret": secret },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }

  if (!res.ok) {
    const message = body?.error || `usage events fetch failed (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return body || { events: [], nextCursor: Number(cursor) || 0 };
}

/**
 * Build the URL the user can open in a browser tab to view the live worker
 * dashboard.
 */
export function buildWorkerDashboardUrl(workerUrl, secret) {
  const base = normalizeUrl(workerUrl);
  const params = new URLSearchParams({
    token: secret,
  });
  return `${base}/admin/status?${params.toString()}`;
}
