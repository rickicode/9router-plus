import * as log from "../utils/logger.js";
import { deleteMachineData, getMachineData, saveMachineData, invalidateRuntimeConfig, getRuntimeConfig } from "../services/storage.js";
import { getState, getUptime } from "../services/state.js";
import { getAllUsage } from "../services/usage.js";
import { extractSecret, isSecretValid, constantTimeEqual } from "../utils/secret.js";

const WORKER_VERSION = "0.3.0";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function normalizeRuntimeUrl(value) {
  if (value === undefined || value === null || value === "") return null;

  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return { error: "Invalid runtimeUrl" };
  }

  if (url.protocol !== "https:") {
    return { error: "runtimeUrl must use HTTPS" };
  }

  return url.toString().replace(/\/$/, "");
}

function normalizeCacheTtlSeconds(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 300) {
    return { error: "Invalid cacheTtlSeconds" };
  }

  return value;
}

function resolveRegistrationMetaField(bodyValue, existingValue) {
  return bodyValue === null ? existingValue ?? null : bodyValue;
}

/**
 * GET /admin/health
 * Public liveness probe used by the dashboard to render an "online/offline" pill.
 * Intentionally returns no machine-specific data and never reveals whether a
 * given machineId exists.
 */
export function handleAdminHealth() {
  return jsonResponse({
    ok: true,
    version: WORKER_VERSION,
    uptime: getUptime(),
    timestamp: new Date().toISOString()
  });
}

/**
 * POST /admin/register
 * Body: { machineId: string, secret: string }
 *
 * Registers a shared secret for a machineId. Behaviour:
 * - If no record exists yet, stores the secret (first-claim wins).
 * - If a record exists and `meta.secret` is empty (legacy data), claims it
 *   one-time using the presented secret.
 * - If a record exists with a stored secret, the request must present the
 *   same secret to be accepted (idempotent re-register).
 *
 * This replaces the old "bootstrap unauth" behaviour of POST /sync/:machineId,
 * which let any caller seed the data for a fresh machineId.
 */
export async function handleAdminRegister(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const machineId = String(body?.machineId || "").trim();
  const secret = String(body?.secret || "").trim();
  const runtimeUrl = normalizeRuntimeUrl(body?.runtimeUrl);
  const cacheTtlSeconds = normalizeCacheTtlSeconds(body?.cacheTtlSeconds);

  if (!machineId || machineId.length < 3) {
    return jsonResponse({ error: "Invalid machineId" }, 400);
  }
  if (!secret || secret.length < 16) {
    return jsonResponse({ error: "Secret must be at least 16 characters" }, 400);
  }
  if (runtimeUrl?.error) {
    return jsonResponse({ error: runtimeUrl.error }, 400);
  }
  if (cacheTtlSeconds?.error) {
    return jsonResponse({ error: cacheTtlSeconds.error }, 400);
  }

  const existing = await getMachineData(machineId, env);
  const now = new Date().toISOString();

  if (existing) {
    const storedSecret = existing.meta?.secret;
    if (storedSecret) {
      if (!constantTimeEqual(storedSecret, secret)) {
        log.warn("ADMIN", "Register rejected: secret mismatch", { machineId });
        return jsonResponse({ error: "Secret mismatch — machine already registered" }, 401);
      }
      // Idempotent re-register; refresh registeredAt for visibility
      const nextRuntimeUrl = resolveRegistrationMetaField(runtimeUrl, existing.meta?.runtimeUrl);
      const nextCacheTtlSeconds = resolveRegistrationMetaField(cacheTtlSeconds, existing.meta?.cacheTtlSeconds);
      existing.meta = {
        ...existing.meta,
        secret,
        registeredAt: existing.meta?.registeredAt || now,
        rotatedAt: now,
        runtimeUrl: nextRuntimeUrl,
        cacheTtlSeconds: nextCacheTtlSeconds
      };
      await saveMachineData(machineId, existing, env);
      log.info("ADMIN", "Re-registered (matching secret)", { machineId });
      return jsonResponse({
        success: true,
        rotated: false,
        registeredAt: existing.meta.registeredAt,
        runtimeUrl: nextRuntimeUrl,
        cacheTtlSeconds: nextCacheTtlSeconds,
        version: WORKER_VERSION
      });
    }

    // Legacy data without a secret — claim it one-time.
    existing.meta = {
      ...(existing.meta || {}),
      secret,
      registeredAt: now,
      claimedLegacy: true,
      runtimeUrl,
      cacheTtlSeconds
    };
    await saveMachineData(machineId, existing, env);
    log.info("ADMIN", "Claimed legacy machine record", { machineId });
    return jsonResponse({
      success: true,
      claimedLegacy: true,
      registeredAt: now,
      runtimeUrl,
      cacheTtlSeconds,
      version: WORKER_VERSION
    });
  }

  // Fresh registration: create an empty record so subsequent /sync calls can
  // authenticate.
  const fresh = {
    providers: {},
    modelAliases: {},
    combos: [],
    apiKeys: [],
    settings: {},
    meta: {
      secret,
      registeredAt: now,
      runtimeUrl,
      cacheTtlSeconds
    }
  };
  await saveMachineData(machineId, fresh, env);
  log.info("ADMIN", "Registered new machine", { machineId });
  return jsonResponse({
    success: true,
    registeredAt: now,
    runtimeUrl,
    cacheTtlSeconds,
    version: WORKER_VERSION
  });
}

/**
 * GET /admin/status.json?token=<secret>
 * Headers may also use X-Cloud-Secret.
 * Required query: machineId
 *
 * Returns the synced view for a single machine: providers, sync stats, usage.
 */
export async function handleAdminStatusJson(request, env) {
  const url = new URL(request.url);
  const machineId = url.searchParams.get("machineId");
  if (!machineId) return jsonResponse({ error: "Missing machineId" }, 400);

  const data = await getMachineData(machineId, env);
  if (!data) return jsonResponse({ error: "Machine not registered" }, 404);

  const presented = extractSecret(request);
  if (!isSecretValid(presented, data)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const runtimeConfig = await getRuntimeConfig(machineId, env, { machineData: data });
  return jsonResponse(buildStatusPayload(machineId, data, runtimeConfig));
}

export async function handleAdminRuntimeRefresh(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const machineId = String(body?.machineId || "").trim();
  if (!machineId) {
    return jsonResponse({ error: "Invalid machineId" }, 400);
  }

  const data = await getMachineData(machineId, env);
  if (!data) {
    return jsonResponse({ error: "Machine not registered" }, 404);
  }

  const presented = extractSecret(request);
  if (!isSecretValid(presented, data)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  await invalidateRuntimeConfig(machineId, env, {
    registration: data?.meta?.runtimeUrl
      ? {
          runtimeUrl: data.meta.runtimeUrl,
          cacheTtlMs: Number.isFinite(data.meta.cacheTtlSeconds)
            ? data.meta.cacheTtlSeconds * 1000
            : data.meta.cacheTtlMs,
        }
      : null,
  });

  const runtimeConfig = await getRuntimeConfig(machineId, env, { forceRefresh: true });

  const refreshedAt = new Date().toISOString();
  data.meta = {
    ...(data.meta || {}),
    runtimeRefreshRequestedAt: refreshedAt,
    runtimeArtifactsLoadedAt: runtimeConfig?.generatedAt || refreshedAt,
  };
  await saveMachineData(machineId, data, env);

  return jsonResponse({
    success: true,
    machineId,
    refreshedAt,
    runtimeGeneratedAt: runtimeConfig?.generatedAt || null,
    credentialsGeneratedAt: runtimeConfig?.credentialsGeneratedAt || null,
    runtimeConfigGeneratedAt: runtimeConfig?.runtimeConfigGeneratedAt || null,
    version: WORKER_VERSION,
  });
}

export async function handleAdminUnregister(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const machineId = String(body?.machineId || "").trim();
  if (!machineId) {
    return jsonResponse({ error: "Invalid machineId" }, 400);
  }

  const data = await getMachineData(machineId, env);
  if (!data) {
    return jsonResponse({ error: "Machine not registered" }, 404);
  }

  const presented = extractSecret(request);
  if (!isSecretValid(presented, data)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  await deleteMachineData(machineId, env);
  log.info("ADMIN", "Unregistered machine", { machineId });

  return jsonResponse({
    success: true,
    machineId,
    unregisteredAt: new Date().toISOString(),
    version: WORKER_VERSION,
  });
}

/**
 * GET /admin/status?token=<secret>&machineId=<id>
 * Server-rendered HTML dashboard. Token comes from the URL so the page can be
 * opened directly in a browser tab from the 9Router web UI.
 */
export async function handleAdminStatusHtml(request, env) {
  const url = new URL(request.url);
  const machineId = url.searchParams.get("machineId");

  if (!machineId) {
    return new Response(renderError("Missing ?machineId in URL"), {
      status: 400,
      headers: HTML_HEADERS
    });
  }

  const data = await getMachineData(machineId, env);
  if (!data) {
    return new Response(renderError("Machine not registered with this worker"), {
      status: 404,
      headers: HTML_HEADERS
    });
  }

  const presented = extractSecret(request);
  if (!isSecretValid(presented, data)) {
    return new Response(renderError("Unauthorized — token missing or incorrect"), {
      status: 401,
      headers: HTML_HEADERS
    });
  }

  const runtimeConfig = await getRuntimeConfig(machineId, env, { machineData: data });
  const payload = buildStatusPayload(machineId, data, runtimeConfig);
  return new Response(renderDashboard(payload), {
    status: 200,
    headers: HTML_HEADERS
  });
}

function buildStatusPayload(machineId, data, runtimeConfig = null) {
  const state = getState();
  const usage = getAllUsage();
  const effectiveConfig = runtimeConfig || data || {};

  const providers = Object.entries(effectiveConfig.providers || {}).map(([id, p]) => ({
    id,
    provider: p.provider,
    name: p.name,
    displayName: p.displayName,
    email: p.email,
    authType: p.authType,
    isActive: p.isActive !== false,
    routingStatus: p.routingStatus || "eligible",
    healthStatus: p.healthStatus || "healthy",
    quotaState: p.quotaState || "ok",
    authState: p.authState || "ok",
    priority: p.priority,
    expiresAt: p.expiresAt || null,
    lastCheckedAt: p.lastCheckedAt || null,
    nextRetryAt: p.nextRetryAt || null,
    updatedAt: p.updatedAt,
    usage: usage[id] || { requests: 0, tokensInput: 0, tokensOutput: 0, errors: 0, lastUsed: null }
  }));

  const meta = data.meta || {};

  return {
    ok: true,
    version: WORKER_VERSION,
    uptime: getUptime(),
    machineId,
    registeredAt: meta.registeredAt || null,
    rotatedAt: meta.rotatedAt || null,
    lastSyncAt: meta.lastSyncAt || state.lastSyncAt || null,
    syncCount: meta.syncCount || 0,
    providers,
    counts: {
      providers: providers.length,
      activeProviders: providers.filter((p) => p.isActive).length,
      eligibleProviders: providers.filter((p) => p.routingStatus === "eligible" && p.isActive).length,
      modelAliases: Object.keys(effectiveConfig.modelAliases || {}).length,
      combos: (effectiveConfig.combos || []).length,
      apiKeys: (effectiveConfig.apiKeys || []).length
    }
  };
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderError(message) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>9Router Worker</title>
<style>body{margin:0;background:#0a0a0a;color:#eee;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{padding:2rem;border:1px solid #333;border-radius:12px;max-width:520px;text-align:center}
h1{margin:0 0 .75rem;font-size:1.25rem}p{color:#aaa;margin:0}</style></head>
<body><div class="box"><h1>9Router Worker</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

function relativeTime(iso) {
  if (!iso) return "never";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "never";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function statusPillColor(status) {
  switch (status) {
    case "eligible":
    case "healthy":
    case "ok":
      return "#10b981";
    case "cooldown":
    case "degraded":
    case "rate_limited":
      return "#f59e0b";
    default:
      return "#ef4444";
  }
}

function renderDashboard(p) {
  const providerRows = p.providers
    .sort((a, b) => (a.priority || 999) - (b.priority || 999))
    .map((prov) => {
      const usage = prov.usage;
      const totalTokens = (usage.tokensInput || 0) + (usage.tokensOutput || 0);
      return `<tr>
        <td><strong>${escapeHtml(prov.displayName || prov.name || prov.id)}</strong>
          <div class="muted">${escapeHtml(prov.provider)} · ${escapeHtml(prov.authType || "?")}</div></td>
        <td>${escapeHtml(prov.email || "—")}</td>
        <td><span class="pill" style="background:${statusPillColor(prov.routingStatus)}1a;color:${statusPillColor(prov.routingStatus)}">${escapeHtml(prov.routingStatus)}</span></td>
        <td>${escapeHtml(relativeTime(prov.expiresAt))}</td>
        <td>${escapeHtml(relativeTime(prov.lastCheckedAt))}</td>
        <td class="num">${usage.requests || 0}</td>
        <td class="num">${totalTokens}</td>
        <td class="num">${usage.errors || 0}</td>
      </tr>`;
    })
    .join("");

  const lastSyncStr = p.lastSyncAt
    ? `${escapeHtml(p.lastSyncAt)} (${escapeHtml(relativeTime(p.lastSyncAt))})`
    : "never";

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>9Router Worker — ${escapeHtml(p.machineId)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0a0a0a;color:#e5e5e5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
.wrap{max-width:1100px;margin:0 auto;padding:2rem 1.5rem}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1.5rem}
h1{margin:0;font-size:1.5rem}
.muted{color:#888;font-size:.85rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;margin:1rem 0 2rem}
.card{background:#141414;border:1px solid #2a2a2a;border-radius:10px;padding:.9rem 1rem}
.card .label{font-size:.7rem;letter-spacing:.05em;color:#888;text-transform:uppercase}
.card .value{font-size:1.4rem;font-weight:600;margin-top:.25rem}
table{width:100%;border-collapse:collapse;background:#141414;border:1px solid #2a2a2a;border-radius:10px;overflow:hidden}
th,td{padding:.65rem .85rem;border-bottom:1px solid #1f1f1f;text-align:left;font-size:.88rem}
th{background:#1a1a1a;font-weight:600;color:#aaa;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
tr:last-child td{border-bottom:none}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:.15rem .55rem;border-radius:999px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.empty{padding:2rem;text-align:center;color:#777}
footer{margin-top:2rem;color:#555;font-size:.75rem;text-align:center}
</style></head>
<body><div class="wrap">
<header>
  <div>
    <h1>9Router Worker Dashboard</h1>
    <div class="muted">machineId: <code>${escapeHtml(p.machineId)}</code></div>
  </div>
  <div class="muted">v${escapeHtml(p.version)} · uptime ${Math.floor(p.uptime / 60)}m</div>
</header>

<div class="grid">
  <div class="card"><div class="label">Last Sync</div><div class="value">${escapeHtml(p.lastSyncAt ? relativeTime(p.lastSyncAt) : "never")}</div><div class="muted">${escapeHtml(p.lastSyncAt || "—")}</div></div>
  <div class="card"><div class="label">Sync Count</div><div class="value">${p.syncCount}</div></div>
  <div class="card"><div class="label">Providers</div><div class="value">${p.counts.providers}</div><div class="muted">${p.counts.eligibleProviders} eligible</div></div>
  <div class="card"><div class="label">API Keys</div><div class="value">${p.counts.apiKeys}</div></div>
  <div class="card"><div class="label">Aliases / Combos</div><div class="value">${p.counts.modelAliases}/${p.counts.combos}</div></div>
  <div class="card"><div class="label">Registered</div><div class="value" style="font-size:1rem">${escapeHtml(relativeTime(p.registeredAt))}</div><div class="muted">${escapeHtml(p.registeredAt || "—")}</div></div>
</div>

<h2 style="font-size:1rem;margin:0 0 .5rem;color:#aaa;text-transform:uppercase;letter-spacing:.05em">Synced Providers</h2>
${
  providerRows
    ? `<table><thead><tr>
        <th>Provider</th><th>Account</th><th>Status</th><th>Token Expires</th><th>Last Checked</th>
        <th class="num">Requests</th><th class="num">Tokens</th><th class="num">Errors</th>
      </tr></thead><tbody>${providerRows}</tbody></table>`
    : `<div class="card empty">No providers synced yet. Open 9Router → Endpoint → Cloud and trigger a sync.</div>`
}

<footer>Last sync: ${lastSyncStr}</footer>
</div></body></html>`;
}

export const __testing = { buildStatusPayload, escapeHtml, relativeTime };
