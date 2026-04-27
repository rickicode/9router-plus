import * as log from "../utils/logger.js";
import { createRuntimeConfigLoader } from "./runtimeConfig.js";

async function withTimeout(promise, timeoutMs = 5000, operation = "R2 operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${operation} timeout after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

// Request-scoped cache with LRU eviction
const requestCache = new Map();
const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 5000;
const runtimeConfigLoader = createRuntimeConfigLoader();

function cleanupCache() {
  if (requestCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(requestCache.entries());
    const toKeep = entries
      .sort((a, b) => b[1].timestamp - a[1].timestamp)
      .slice(0, MAX_CACHE_SIZE);
    requestCache.clear();
    toKeep.forEach(([key, value]) => requestCache.set(key, value));
  }
}

/**
 * R2 key helpers
 */
function machineKey(machineId) {
  return `machines/${machineId}.json`;
}

function settingsKey(machineId) {
  return `settings/${machineId}.json`;
}

function usageKey(machineId, dateStr) {
  return `usage/${machineId}/${dateStr}.json`;
}

function requestLogKey(machineId, dateStr) {
  return `requests/${machineId}/${dateStr}.json`;
}

function backupKey(timestamp) {
  return `backups/sqlite-${timestamp}.db`;
}

/**
 * Get machine data from R2 (with request-scope caching)
 * @param {string} machineId
 * @param {Object} env
 * @returns {Promise<Object|null>}
 */
export async function getMachineData(machineId, env) {
  const cached = requestCache.get(machineId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const key = machineKey(machineId);
  const obj = await withTimeout(
    env.R2_DATA.get(key),
    5000,
    "getMachineData"
  );
  
  if (!obj) {
    log.debug("STORAGE", `Not found: ${machineId}`);
    return null;
  }
  
  const data = await obj.json();
  requestCache.set(machineId, { data, timestamp: Date.now() });
  cleanupCache();
  log.debug("STORAGE", `Retrieved: ${machineId}`);
  return data;
}

/**
 * Get runtime registration metadata for a machine.
 * @param {string} machineId
 * @param {Object} env
 * @returns {Promise<Object|null>}
 */
export async function getRuntimeRegistration(machineId, env) {
  const data = await getMachineData(machineId, env);
  const meta = data?.meta;

  if (!meta?.runtimeUrl) {
    return null;
  }

  const registration = {
    runtimeUrl: meta.runtimeUrl
  };

  if (meta.routingConfig && typeof meta.routingConfig === "object" && !Array.isArray(meta.routingConfig)) {
    registration.routingConfig = meta.routingConfig;
  }

  if (Number.isFinite(meta.cacheTtlSeconds)) {
    registration.cacheTtlMs = meta.cacheTtlSeconds * 1000;
  } else if (Number.isFinite(meta.cacheTtlMs)) {
    registration.cacheTtlMs = meta.cacheTtlMs;
  }

  return registration;
}

/**
 * Get remote runtime config for a machine registration.
 * @param {string} machineId
 * @param {Object} env
 * @param {Object} options
 * @returns {Promise<Object|null>}
 */
export async function getRuntimeConfig(machineId, env, options = {}) {
  const registration = await getRuntimeRegistration(machineId, env);
  if (!registration) {
    return null;
  }

  const loader = options.runtimeConfigLoader || runtimeConfigLoader;
  return loader.load(machineId, registration);
}

/**
 * Save machine data to R2
 * @param {string} machineId
 * @param {Object} data
 * @param {Object} env
 */
export async function saveMachineData(machineId, data, env) {
  const now = new Date().toISOString();
  data.updatedAt = now;
  
  const key = machineKey(machineId);
  await withTimeout(
    env.R2_DATA.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { machineId, updatedAt: now }
    }),
    5000,
    "saveMachineData"
  );
  
  // Update cache after save
  requestCache.set(machineId, { data, timestamp: Date.now() });
  log.debug("STORAGE", `Saved: ${machineId}`);
}

/**
 * Delete machine data from R2
 * @param {string} machineId
 * @param {Object} env
 */
export async function deleteMachineData(machineId, env) {
  const key = machineKey(machineId);
  await env.R2_DATA.delete(key);
  
  // Clear cache after delete
  requestCache.delete(machineId);
  log.debug("STORAGE", `Deleted: ${machineId}`);
}

/**
 * Update specific fields in machine data (for token refresh, rate limit, etc.)
 * @param {string} machineId
 * @param {string} connectionId
 * @param {Object} updates
 * @param {Object} env
 */
export async function updateMachineProvider(machineId, connectionId, updates, env) {
  const data = await getMachineData(machineId, env);
  if (!data?.providers?.[connectionId]) return;
  
  Object.assign(data.providers[connectionId], updates);
  data.providers[connectionId].updatedAt = new Date().toISOString();
  
  await saveMachineData(machineId, data, env);
}

/**
 * Save usage data to R2 for backup
 * @param {string} machineId
 * @param {Object} usageData
 * @param {Object} env
 */
export async function saveUsageData(machineId, usageData, env) {
  const dateStr = new Date().toISOString().split("T")[0];
  const key = usageKey(machineId, dateStr);
  
  // Get existing data for today and merge
  let existing = {};
  try {
    const obj = await env.R2_DATA.get(key);
    if (obj) existing = await obj.json();
  } catch {
    // ignore
  }
  
  const merged = {
    ...existing,
    ...usageData,
    updatedAt: new Date().toISOString()
  };
  
  await env.R2_DATA.put(key, JSON.stringify(merged), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { machineId, date: dateStr }
  });
  
  log.debug("STORAGE", `Usage saved for ${machineId} (${dateStr})`);
}

/**
 * Get usage data from R2
 * @param {string} machineId
 * @param {string} dateStr - YYYY-MM-DD
 * @param {Object} env
 * @returns {Promise<Object|null>}
 */
export async function getUsageData(machineId, dateStr, env) {
  const key = usageKey(machineId, dateStr);
  const obj = await env.R2_DATA.get(key);
  if (!obj) return null;
  return obj.json();
}

/**
 * Save request log data to R2 for backup
 * @param {string} machineId
 * @param {Object} requestData
 * @param {Object} env
 */
export async function saveRequestLog(machineId, requestData, env) {
  const dateStr = new Date().toISOString().split("T")[0];
  const key = requestLogKey(machineId, dateStr);
  
  let existing = { entries: [] };
  try {
    const obj = await env.R2_DATA.get(key);
    if (obj) existing = await obj.json();
  } catch {
    // ignore
  }
  
  existing.entries.push({
    ...requestData,
    timestamp: new Date().toISOString()
  });
  
  // Limit entries per day
  if (existing.entries.length > 10000) {
    existing.entries = existing.entries.slice(-10000);
  }
  
  await env.R2_DATA.put(key, JSON.stringify(existing), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { machineId, date: dateStr }
  });
}

/**
 * Save SQLite backup to R2
 * @param {ArrayBuffer|Uint8Array} sqliteData - raw SQLite file data
 * @param {Object} env
 * @returns {Promise<string>} backup key
 */
export async function saveSqliteBackup(sqliteData, env) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = backupKey(timestamp);
  
  await env.R2_DATA.put(key, sqliteData, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { type: "sqlite-backup", timestamp }
  });
  
  log.info("STORAGE", `SQLite backup saved: ${key}`);
  return key;
}

/**
 * List all SQLite backups from R2
 * @param {Object} env
 * @returns {Promise<Array>}
 */
export async function listSqliteBackups(env) {
  const listed = await env.R2_DATA.list({ prefix: "backups/" });
  return (listed.objects || []).map(obj => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded?.toISOString(),
    ...obj.customMetadata
  }));
}

/**
 * Get a SQLite backup from R2
 * @param {string} key
 * @param {Object} env
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function getSqliteBackup(key, env) {
  const obj = await env.R2_DATA.get(key);
  if (!obj) return null;
  return obj.arrayBuffer();
}

/**
 * List all machine IDs stored in R2
 * @param {Object} env
 * @returns {Promise<Array<string>>}
 */
export async function listMachines(env) {
  const listed = await env.R2_DATA.list({ prefix: "machines/" });
  return (listed.objects || []).map(obj => {
    const match = obj.key.match(/^machines\/(.+)\.json$/);
    return match ? match[1] : null;
  }).filter(Boolean);
}

/**
 * Export all data from R2 for a machine (for restore/rollback)
 * @param {string} machineId
 * @param {Object} env
 * @returns {Promise<Object>}
 */
export async function exportMachineData(machineId, env) {
  const data = await getMachineData(machineId, env);
  
  // Collect usage data (last 30 days)
  const usageEntries = {};
  const today = new Date();
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const usage = await getUsageData(machineId, dateStr, env);
    if (usage) usageEntries[dateStr] = usage;
  }
  
  return {
    machineData: data,
    usage: usageEntries,
    exportedAt: new Date().toISOString()
  };
}
