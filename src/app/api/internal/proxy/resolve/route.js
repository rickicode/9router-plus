import { NextResponse } from "next/server";
import { getProviderConnections, getSettings } from "@/lib/localDb";
import { getEligibleConnections } from "@/lib/providerHotState";
import { getConnectionStatusDetails } from "@/lib/connectionStatus";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { getInternalProxyTokens } from "@/lib/internalProxyTokens";
import { recordRoutingLatency } from "@/lib/routingLatency";

const INTERNAL_AUTH_HEADER = "x-internal-auth";

async function hasValidInternalAuth(request) {
  const tokens = await getInternalProxyTokens();
  const expectedToken = tokens.resolveToken;
  if (!expectedToken) return false;

  const providedToken = request.headers.get(INTERNAL_AUTH_HEADER);
  return Boolean(providedToken) && providedToken === expectedToken;
}

const ALLOWED_PROTOCOL_PATHS = {
  openai: new Set([
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/embeddings",
    "/v1/audio/speech",
    "/v1/images/generations",
  ]),
  anthropic: new Set(["/v1/messages"]),
};

function normalizeTtlSeconds() {
  const raw = Number(process.env.GO_PROXY_RESOLVE_CACHE_TTL_SECONDS);
  const fallback = 7;
  const value = Number.isFinite(raw) ? raw : fallback;
  return Math.max(5, Math.min(10, Math.floor(value)));
}

function sortByPriority(connections = []) {
  return [...connections].sort((a, b) => (a.priority || 999) - (b.priority || 999));
}

function sortByRecencyDesc(connections = []) {
  return [...connections].sort((a, b) => {
    if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
    if (!a.lastUsedAt) return 1;
    if (!b.lastUsedAt) return -1;
    return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
  });
}

function sortByRecencyAsc(connections = []) {
  return [...connections].sort((a, b) => {
    if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
    if (!a.lastUsedAt) return -1;
    if (!b.lastUsedAt) return 1;
    return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
  });
}

function sanitizeConnection(connection = {}) {
  const status = getConnectionStatusDetails(connection);
  return {
    connectionId: connection.id,
    provider: connection.provider,
    status: status.status,
    statusSource: status.source,
    cooldownUntil: status.cooldownUntil,
    hasActiveModelLock: status.hasActiveModelLock,
  };
}

function validateRouteContract(protocolFamily, publicPath) {
  if (!protocolFamily || !publicPath) return false;
  const allowedPaths = ALLOWED_PROTOCOL_PATHS[protocolFamily];
  if (!allowedPaths) return false;
  return allowedPaths.has(publicPath);
}

function pickConnections(selectionPool = [], strategy = "fill-first") {
  const pool = sortByPriority(selectionPool);
  if (pool.length === 0) return { chosen: null, fallbackChain: [] };

  if (strategy === "round-robin") {
    const stickyLimit = 3;
    const byRecency = sortByRecencyDesc(pool);
    const current = byRecency[0];
    const currentCount = current?.consecutiveUseCount || 0;

    const chosen = (current && current.lastUsedAt && currentCount < stickyLimit)
      ? current
      : sortByRecencyAsc(pool)[0];

    const fallbackChain = pool.filter((connection) => connection.id !== chosen.id);
    return { chosen, fallbackChain };
  }

  return {
    chosen: pool[0],
    fallbackChain: pool.slice(1),
  };
}

export async function POST(request) {
  const startedAt = Date.now();
  let providerForMetric = null;
  let metricStatus = "ok";

  try {
    if (!(await hasValidInternalAuth(request))) {
      metricStatus = "unauthorized";
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      metricStatus = "invalid_request";
      return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }

    const providerInput = payload?.provider;
    const model = payload?.model || null;
    const protocolFamily = payload?.protocolFamily;
    const publicPath = payload?.publicPath;

    if (!providerInput || !model || !protocolFamily || !publicPath) {
      metricStatus = "invalid_request";
      return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }

    if (!validateRouteContract(protocolFamily, publicPath)) {
      metricStatus = "invalid_route_contract";
      return NextResponse.json({ ok: false, error: "invalid_route_contract" }, { status: 400 });
    }

    const provider = resolveProviderId(providerInput);
    providerForMetric = provider;
    const connections = await getProviderConnections({ provider, isActive: true });
    const availableConnections = Array.isArray(connections) ? connections : [];

    const centralizedEligibleConnections = await getEligibleConnections(provider, availableConnections);
    const selectionPool = Array.isArray(centralizedEligibleConnections)
      ? centralizedEligibleConnections
      : availableConnections.filter((connection) => getConnectionStatusDetails(connection).status === "eligible");

    if (selectionPool.length === 0) {
      metricStatus = "no_routable_connection";
      return NextResponse.json({ ok: false, error: "no_routable_connection", owner: "9router" }, { status: 503 });
    }

    const settings = await getSettings();
    const providerOverride = (settings?.providerStrategies || {})[provider] || {};
    const strategy = providerOverride.fallbackStrategy || settings?.fallbackStrategy || "fill-first";

    const { chosen, fallbackChain } = pickConnections(selectionPool, strategy);
    const ttlSeconds = normalizeTtlSeconds();

    return NextResponse.json({
      ok: true,
      owner: "9router",
      resolution: {
        provider,
        model,
        protocolFamily,
        publicPath,
        ttlSeconds,
        chosenConnection: sanitizeConnection(chosen),
        fallbackChain: fallbackChain.length > 0 ? fallbackChain.map(sanitizeConnection) : undefined,
      },
    });
  } catch (error) {
    metricStatus = "error";
    throw error;
  } finally {
    recordRoutingLatency({
      ms: Date.now() - startedAt,
      providerId: providerForMetric,
      status: metricStatus,
    });
  }
}
