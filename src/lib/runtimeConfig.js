import { randomUUID } from "node:crypto";
import { loadSingletonFromSqlite, upsertSingleton } from "./sqliteHelpers.js";

const CONFIG_FILE = null;

const DEFAULT_CONFIG = {
  version: 1,
  redis: {
    enabled: false,
    activeServerId: null,
    lastStatus: {
      ready: false,
      checkedAt: null,
      url: null,
      error: null,
    },
    servers: [],
  },
};

function cloneDefaultConfig() {
  return {
    version: DEFAULT_CONFIG.version,
    redis: {
      enabled: DEFAULT_CONFIG.redis.enabled,
      activeServerId: DEFAULT_CONFIG.redis.activeServerId,
      lastStatus: { ...DEFAULT_CONFIG.redis.lastStatus },
      servers: [],
    },
  };
}

function ensureConfigShape(config) {
  const next = config && typeof config === "object" ? config : {};
  const fallback = cloneDefaultConfig();

  if (typeof next.version !== "number") next.version = fallback.version;
  if (!next.redis || typeof next.redis !== "object" || Array.isArray(next.redis)) {
    next.redis = fallback.redis;
    return next;
  }

  if (typeof next.redis.enabled !== "boolean") next.redis.enabled = fallback.redis.enabled;
  if (next.redis.activeServerId === undefined) next.redis.activeServerId = fallback.redis.activeServerId;
  if (!next.redis.lastStatus || typeof next.redis.lastStatus !== "object" || Array.isArray(next.redis.lastStatus)) {
    next.redis.lastStatus = { ...fallback.redis.lastStatus };
  } else {
    if (typeof next.redis.lastStatus.ready !== "boolean") next.redis.lastStatus.ready = false;
    if (next.redis.lastStatus.checkedAt === undefined) next.redis.lastStatus.checkedAt = null;
    if (next.redis.lastStatus.url === undefined) next.redis.lastStatus.url = null;
    if (next.redis.lastStatus.error === undefined) next.redis.lastStatus.error = null;
  }

  if (!Array.isArray(next.redis.servers)) next.redis.servers = [];
  next.redis.servers = next.redis.servers.filter((server) => server && typeof server === "object" && typeof server.url === "string" && server.url.trim());

  return next;
}

export async function readRuntimeConfig() {
  try {
    return ensureConfigShape(loadSingletonFromSqlite("runtimeConfig") || cloneDefaultConfig());
  } catch (error) {
    throw error;
  }
}

export async function writeRuntimeConfig(config) {
  const next = ensureConfigShape(config);
  upsertSingleton("runtimeConfig", next);
  return next;
}

export function cloneRuntimeConfig(config) {
  return ensureConfigShape(JSON.parse(JSON.stringify(config || cloneDefaultConfig())));
}

export function getActiveRedisServer(config) {
  const next = ensureConfigShape(config);
  if (next.redis.enabled !== true) return null;
  if (next.redis.activeServerId) {
    const active = next.redis.servers.find((server) => server.id === next.redis.activeServerId);
    if (active) return active;
  }

  return next.redis.servers[0] || null;
}

export function upsertRedisServer(config, serverInput, mode = "replace") {
  const next = ensureConfigShape(config);
  const now = new Date().toISOString();
  const url = typeof serverInput === "string" ? serverInput : serverInput?.url;
  if (!url || typeof url !== "string" || !url.trim()) {
    return next;
  }

  const normalizedUrl = url.trim();
  const serverName = typeof serverInput === "object" && typeof serverInput?.name === "string" ? serverInput.name.trim() : "";
  const serverId = typeof serverInput === "object" && typeof serverInput?.id === "string" ? serverInput.id : null;
  const indexById = serverId ? next.redis.servers.findIndex((server) => server.id === serverId) : -1;
  const indexByUrl = next.redis.servers.findIndex((server) => server.url === normalizedUrl);
  const index = mode === "replace" ? (indexById !== -1 ? indexById : indexByUrl) : indexByUrl;

  if (index !== -1) {
    next.redis.servers[index] = {
      ...next.redis.servers[index],
      url: normalizedUrl,
      name: serverName || next.redis.servers[index].name || `Redis ${index + 1}`,
      updatedAt: now,
    };
    next.redis.activeServerId = next.redis.servers[index].id;
  } else {
    const id = serverId || randomUUID();
    const entry = {
      id,
      url: normalizedUrl,
      name: serverName || `Redis ${next.redis.servers.length + 1}`,
      createdAt: now,
      updatedAt: now,
    };
    next.redis.servers.push(entry);
    next.redis.activeServerId = id;
  }

  next.redis.enabled = true;
  return next;
}

export function setRedisStatus(config, status) {
  const next = ensureConfigShape(config);
  next.redis.lastStatus = {
    ready: Boolean(status?.ready),
    checkedAt: status?.checkedAt || new Date().toISOString(),
    url: status?.url || null,
    error: status?.error || null,
  };
  return next;
}

export function disableRedis(config) {
  const next = ensureConfigShape(config);
  next.redis.enabled = false;
  next.redis.lastStatus = {
    ready: false,
    checkedAt: new Date().toISOString(),
    url: null,
    error: null,
  };
  return next;
}

export function getRedisUrlFromConfig(config) {
  const active = getActiveRedisServer(config);
  return active?.url || null;
}

export { CONFIG_FILE };
