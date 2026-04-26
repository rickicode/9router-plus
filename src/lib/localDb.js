import { v4 as uuidv4 } from "uuid";
import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";
import { isHotStateKey } from "@/lib/hotStateKeys.js";
import { DB_SQLITE_FILE, clearHotStateForProvider, deleteEntity, ensureSchema, getSqliteDb, loadAllDataFromSqlite, loadSingletonFromSqlite, markProviderHotStateInvalidated, migrateFromJSON, rebuildHotStateFromConnections, saveAllDataToSqlite, upsertEntities, upsertEntity, upsertSingleton } from "@/lib/sqliteHelpers.js";
import { getConnectionEffectiveStatus, getConnectionStatusDetails } from "@/lib/connectionStatus.js";
import { sanitizeConnectionStatusRecord } from "./providerHotState.js";
import { normalizeQuotaSchedulerSettings } from "./quotaRefreshPlanner.js";
import { clearAllHotState, clearProviderHotState, deleteConnectionHotState, extractHotState, mergeConnectionsWithHotState, setConnectionHotState, isHotOnlyUpdate, isRedisHotStateReady } from "@/lib/quotaStateStore.js";
import {
  createDefaultOpenCodePreferences,
  normalizeOpenCodePreferences,
  validateOpenCodePreferences,
} from "@/lib/opencodeSync/schema.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
export const DB_BACKUP_FORMAT = "9router-db-v1";
export const DB_BACKUP_SCHEMA_VERSION = 1;
const LEGACY_MIRROR_STATUS_FIELDS = new Set([
  "testStatus",
  "lastError",
  "lastErrorType",
  "lastErrorAt",
  "rateLimitedUntil",
  "errorCode",
  "lastTested",
]);

function stripLegacyMirrorStatusPatch(record = {}) {
  return Object.fromEntries(
    Object.entries(sanitizeConnectionStatusRecord(record || {})).filter(([key]) => !LEGACY_MIRROR_STATUS_FIELDS.has(key))
  );
}

function stripLegacyMirrorStatusFields(record = {}) {
  return Object.fromEntries(
    Object.entries(sanitizeConnectionStatusRecord(record || {})).filter(([key]) => !LEGACY_MIRROR_STATUS_FIELDS.has(key))
  );
}

const isCloud = typeof caches !== 'undefined' && typeof caches === 'object';
const DB_FILE = isCloud ? null : path.join(DATA_DIR, "db.json");

if (!isCloud && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  // cloudUrls is intentionally empty by default. Each entry is created via the
  // dashboard "Add Cloud URL" flow which also generates a per-worker shared
  // secret used by the Worker's /admin/* endpoints.
  cloudUrls: [],
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  comboStrategy: "fallback",
  comboStrategies: {},
  roundRobin: false,
  sticky: false,
  stickyDuration: 300,
  requireLogin: true,
  tunnelDashboardAccess: true,
  observabilityEnabled: true,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 1024,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  quotaExhaustedThresholdPercent: 10,
  
  // Security settings
  ipWhitelist: ["127.0.0.1", "::1", "172.17.0.0/16"],
  trustedProxyEnabled: false,
  auditLogEnabled: true,
  auditLogMaxSize: 10485760, // 10MB
};

const LEGACY_REMOVED_SETTINGS_KEYS = [
  String.fromCharCode(114, 116, 107, 69, 110, 97, 98, 108, 101, 100),
];

const CANONICAL_STATUS_KEYS = ["routingStatus", "healthStatus", "quotaState", "authState"];

function hasCanonicalStatus(connection = {}) {
  return CANONICAL_STATUS_KEYS.some((key) => connection?.[key] !== undefined && connection?.[key] !== null);
}

function buildEligibilityRecoveryPatch() {
  const now = new Date().toISOString();
  return {
    routingStatus: "eligible",
    healthStatus: "healthy",
    quotaState: "ok",
    authState: "ok",
    reasonCode: "unknown",
    reasonDetail: null,
    nextRetryAt: null,
    resetAt: null,
    testStatus: "active",
    lastError: null,
    lastErrorType: null,
    lastErrorAt: null,
    rateLimitedUntil: null,
    errorCode: null,
    backoffLevel: 0,
    lastCheckedAt: now,
    lastTested: now,
  };
}

function shouldSeedEligibility(connection = {}) {
  return connection?.isActive !== false && !hasCanonicalStatus(connection);
}

function normalizeQuotaExhaustedThresholdPercent(value) {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.quotaExhaustedThresholdPercent;
  return Math.min(100, Math.max(0, value));
}

function mergeSettingsWithDefaults(settings = {}) {
  const sourceSettings = settings && typeof settings === "object" && !Array.isArray(settings)
    ? { ...settings }
    : {};

  for (const legacyKey of LEGACY_REMOVED_SETTINGS_KEYS) {
    delete sourceSettings[legacyKey];
  }

  const merged = {
    ...DEFAULT_SETTINGS,
    ...sourceSettings,
  };

  merged.quotaExhaustedThresholdPercent = normalizeQuotaExhaustedThresholdPercent(
    sourceSettings?.quotaExhaustedThresholdPercent
  );

  merged.quotaScheduler = {
    ...normalizeQuotaSchedulerSettings(
      sourceSettings?.quotaScheduler && typeof sourceSettings.quotaScheduler === "object" && !Array.isArray(sourceSettings.quotaScheduler)
        ? sourceSettings.quotaScheduler
        : {}
    ),
  };

  return merged;
}

function cloneDefaultData() {
  return {
    providerConnections: [],
    providerNodes: [],
    proxyPools: [],
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    combos: [],
    apiKeys: [],
    settings: mergeSettingsWithDefaults({}),
    pricing: {},
  };
}

function validateDbImportPayload(payload) {
  if (!isPlainObject(payload)) {
    throw new Error("Invalid database payload: expected an object");
  }

  if (payload.format !== DB_BACKUP_FORMAT) {
    throw new Error(`Invalid database payload format: expected ${DB_BACKUP_FORMAT}`);
  }

  const defaults = cloneDefaultData();
  const allowedKeys = new Set([
    "format",
    "schemaVersion",
    ...Object.keys(defaults),
    "opencodeSync",
    "runtimeConfig",
    "tunnelState",
  ]);

  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Invalid database payload: unknown top-level key ${key}`);
    }
  }

  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (payload[key] === undefined) continue;

    if (Array.isArray(defaultValue) && !Array.isArray(payload[key])) {
      throw new Error(`Invalid database payload: ${key} must be an array`);
    }

    if (isPlainObject(defaultValue) && !isPlainObject(payload[key])) {
      throw new Error(`Invalid database payload: ${key} must be an object`);
    }
  }
}

function logSafeError(message, error) {
  console.warn(message, {
    name: error?.name,
    code: error?.code,
    message: error?.message,
  });
}

export { getConnectionEffectiveStatus };

export function getConnectionStatusSummary(connections = []) {
  const summary = {
    connected: 0,
    error: 0,
    unknown: 0,
    total: connections.length,
    allDisabled: connections.length > 0 && connections.every((c) => c?.isActive === false),
  };

  for (const connection of connections || []) {
    const status = getConnectionStatusDetails(connection).status;

    if (status === "eligible") summary.connected += 1;
    else if (status === "blocked" || status === "exhausted") summary.error += 1;
    else summary.unknown += 1;
  }

  return summary;
}

function ensureDbShape(data) {
  const defaults = cloneDefaultData();
  const next = data && typeof data === "object" ? data : {};
  let changed = false;

  if (Array.isArray(next.providerConnections)) {
    for (const connection of next.providerConnections) {
      if (!shouldSeedEligibility(connection)) continue;
      Object.assign(connection, buildEligibilityRecoveryPatch());
      changed = true;
    }
  }

  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (next[key] === undefined || next[key] === null) {
      next[key] = defaultValue;
      changed = true;
      continue;
    }

    if (key === "settings" && (typeof next.settings !== "object" || Array.isArray(next.settings))) {
      next.settings = { ...defaultValue };
      changed = true;
      continue;
    }

    if (key === "settings" && typeof next.settings === "object" && !Array.isArray(next.settings)) {
      for (const [settingKey, settingDefault] of Object.entries(defaultValue)) {
        if (next.settings[settingKey] === undefined) {
          // Backward-compat: if proxy URL was saved, default outboundProxyEnabled to true
          if (
            settingKey === "outboundProxyEnabled" &&
            typeof next.settings.outboundProxyUrl === "string" &&
            next.settings.outboundProxyUrl.trim()
          ) {
            next.settings.outboundProxyEnabled = true;
          } else {
            next.settings[settingKey] = settingDefault;
          }
          changed = true;
        }
      }

      const mergedSettings = mergeSettingsWithDefaults(next.settings);
      if (JSON.stringify(mergedSettings) !== JSON.stringify(next.settings)) {
        next.settings = mergedSettings;
        changed = true;
      }

      if (Array.isArray(next.settings.cloudUrls)) {
        const seen = new Set();
        const deduped = next.settings.cloudUrls.filter((url) => {
          const key = String(url?.url ?? "").toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        if (deduped.length !== next.settings.cloudUrls.length) {
          next.settings.cloudUrls = deduped;
          changed = true;
        }
      }

      // Drop the legacy localhost:8787 seed if we still have it. It used to be
      // injected automatically here, which leaked into production setups.
      if (Array.isArray(next.settings.cloudUrls)) {
        const filtered = next.settings.cloudUrls.filter((entry) => {
          const u = String(entry?.url ?? "").toLowerCase();
          if (!u) return false;
          return u !== "http://localhost:8787" && u !== "http://localhost:8787/";
        });
        if (filtered.length !== next.settings.cloudUrls.length) {
          next.settings.cloudUrls = filtered;
          changed = true;
        }
      }
    }

    // Migrate existing API keys to have isActive
    if (key === "apiKeys" && Array.isArray(next.apiKeys)) {
      for (const apiKey of next.apiKeys) {
        if (apiKey.isActive === undefined || apiKey.isActive === null) {
          apiKey.isActive = true;
          changed = true;
        }
      }
    }

    // Validate unique constraints for provider connections
    if (key === "providerConnections" && Array.isArray(next.providerConnections)) {
      const seen = new Map();
      const duplicates = [];

      for (let i = 0; i < next.providerConnections.length; i++) {
        const conn = next.providerConnections[i];
        let uniqueKey;

        if (conn.authType === "oauth" && conn.email) {
          uniqueKey = `${conn.provider}:oauth:${conn.email}`;
        } else if (conn.authType === "apikey" && conn.name) {
          uniqueKey = `${conn.provider}:apikey:${conn.name}`;
        }

        if (uniqueKey) {
          if (seen.has(uniqueKey)) {
            console.warn(`[DB] Duplicate connection detected: ${uniqueKey} (id: ${conn.id}), marking for removal`);
            duplicates.push(i);
          } else {
            seen.set(uniqueKey, conn.id);
          }
        }
      }

      // Remove duplicates (keep first occurrence)
      if (duplicates.length > 0) {
        for (let i = duplicates.length - 1; i >= 0; i--) {
          next.providerConnections.splice(duplicates[i], 1);
        }
        changed = true;
        console.warn(`[DB] Removed ${duplicates.length} duplicate connection(s)`);
      }
    }
  }

  return { data: next, changed };
}

let dbInstance = null;
let dbCache = null;
let dbCacheExpiresAt = 0;
let sqliteInitPromise = null;

const DB_CACHE_TTL_MS = 1000;

class LocalMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return () => this._release();
    }
    return new Promise((resolve) => {
      this._queue.push(() => resolve(() => this._release()));
    });
  }

  _release() {
    const next = this._queue.shift();
    if (next) next();
    else this._locked = false;
  }
}

const localMutex = new LocalMutex();

async function withLocalDbMutex(operation) {
  if (isCloud) {
    await operation();
    return;
  }

  const releaseLocal = await localMutex.acquire();
  try {
    await operation();
  } finally {
    releaseLocal();
  }
}

async function safeRead(db) {
  const { data, rawData, normalizedKeys } = loadAllDataFromStorageState();
  db.data = data;
  db._rawDataFromStorage = rawData;
  db._normalizedKeysOnRead = new Set(normalizedKeys);
}

function cloneDbData(data) {
  if (typeof structuredClone === "function") {
    return structuredClone(data);
  }
  return JSON.parse(JSON.stringify(data));
}

function createMemoryDb(data) {
  return {
    data,
    async read() {
      this.data = loadAllDataFromStorage();
    },
    async write() {
      saveAllDataToStorage(this.data);
    },
  };
}

function loadAllDataFromStorage() {
  return loadAllDataFromStorageState().data;
}

function loadAllDataFromStorageState() {
  if (!isCloud && fs.existsSync(DB_SQLITE_FILE)) {
    const sqliteData = loadAllDataFromSqlite();
    if (loadSingletonFromSqlite("opencodeSync") == null) {
      delete sqliteData.opencodeSync;
    }
    const rawData = cloneDbData(sqliteData);
    const { data } = ensureDbShape(sqliteData);
    return {
      data,
      rawData,
      normalizedKeys: getChangedTopLevelKeys(rawData, data),
    };
  }

  const data = cloneDefaultData();
  return {
    data,
    rawData: cloneDbData(data),
    normalizedKeys: [],
  };
}

function getChangedTopLevelKeys(beforeData, afterData) {
  const keys = new Set([
    ...Object.keys(beforeData || {}),
    ...Object.keys(afterData || {}),
  ]);

  return [...keys].filter((key) => JSON.stringify(beforeData?.[key]) !== JSON.stringify(afterData?.[key]));
}

function saveAllDataToStorage(data) {
  if (isCloud) {
    return;
  }

  const nextData = ensureDbShape(cloneDbData(data)).data;
  saveAllDataToSqlite(nextData);
}

function hasFreshDbCache() {
  return dbCache !== null && Date.now() < dbCacheExpiresAt;
}

function setDbCache(data) {
  dbCache = cloneDbData(data);
  dbCacheExpiresAt = Date.now() + DB_CACHE_TTL_MS;
}

function invalidateDbCache() {
  dbCache = null;
  dbCacheExpiresAt = 0;
}

async function ensureSqliteBootstrap() {
  if (isCloud) return;
  if (!sqliteInitPromise) {
    sqliteInitPromise = (async () => {
      try {
        if (DB_FILE && fs.existsSync(DB_FILE) && !fs.existsSync(DB_SQLITE_FILE)) {
          migrateFromJSON({ preserveJson: false });
        } else {
          // getSqliteDb() opens the file (creating it if absent) and
          // ensureSchema() seeds the schema. We don't need a follow-up
          // !fs.existsSync(DB_SQLITE_FILE) check; it is always false here
          // because better-sqlite3 has just created the file. The fresh
          // empty database picks up its default shape via ensureDbShape()
          // in the first getDb() call.
          const sqliteDb = getSqliteDb();
          ensureSchema(sqliteDb);
        }
      } catch (error) {
        logSafeError("[DB] SQLite bootstrap failed", error);
        // Reset the promise so subsequent callers can retry bootstrap instead
        // of being permanently stuck on a poisoned init promise.
        sqliteInitPromise = null;
        throw error;
      }
    })();
  }

  try {
    await sqliteInitPromise;
  } catch (error) {
    sqliteInitPromise = null;
    throw error;
  }
}

function getProviderConnectionsFromLowDbData(db, filter = {}) {
  let connections = db.data.providerConnections || [];

  if (filter.provider) connections = connections.filter((c) => c.provider === filter.provider);
  if (filter.isActive !== undefined) connections = connections.filter((c) => c.isActive === filter.isActive);

  connections.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return connections;
}

function validateSqliteProviderConnections(connections) {
  if (!Array.isArray(connections)) {
    throw new Error("SQLite providerConnections payload must be an array");
  }

  const validConnections = connections.filter((connection) => connection && typeof connection === "object");

  if (validConnections.length !== connections.length) {
    throw new Error("SQLite providerConnections payload contained invalid records");
  }

  const clonedData = cloneDbData({ providerConnections: validConnections });
  const { data } = ensureDbShape(clonedData);
  return data.providerConnections || [];
}

async function getProviderConnectionsWithFallback(filter = {}) {
  const db = await getDb();
  return getProviderConnectionsFromLowDbData(db, filter);
}

function ensureDbShapeForWrite(db) {
  const { data } = ensureDbShape(db.data);
  db.data = data;
}

async function persistDbWrite(db) {
  invalidateDbCache();
  ensureDbShapeForWrite(db);
  saveAllDataToStorage(db.data);
  setDbCache(db.data);
}

async function persistSingletonWrite(db, key) {
  invalidateDbCache();
  ensureDbShapeForWrite(db);
  upsertSingleton(key, db.data[key]);
  setDbCache(db.data);
  db._rawDataFromStorage = cloneDbData(db.data);
  db._normalizedKeysOnRead = new Set();
}

function getStoredCollectionSnapshot(db, collection) {
  const rawCollection = db?._rawDataFromStorage?.[collection];
  return Array.isArray(rawCollection) ? rawCollection : [];
}

function hasCollectionReadNormalization(db, collection) {
  return db?._normalizedKeysOnRead instanceof Set && db._normalizedKeysOnRead.has(collection);
}

function syncCollectionPersistence(collection, previousEntities, nextEntities) {
  upsertEntities(collection, nextEntities);

  const nextIds = new Set(
    nextEntities
      .filter((entity) => entity && typeof entity.id === "string" && entity.id.length > 0)
      .map((entity) => entity.id)
  );

  for (const entity of previousEntities) {
    if (!entity || typeof entity.id !== "string" || entity.id.length === 0) continue;
    if (!nextIds.has(entity.id)) {
      deleteEntity(collection, entity.id);
    }
  }
}

async function persistCollectionEntityWrite(db, collection, entity) {
  invalidateDbCache();
  ensureDbShapeForWrite(db);
  if (hasCollectionReadNormalization(db, collection)) {
    syncCollectionPersistence(
      collection,
      getStoredCollectionSnapshot(db, collection),
      Array.isArray(db.data?.[collection]) ? db.data[collection] : []
    );
  } else {
    upsertEntity(collection, entity);
  }
  setDbCache(db.data);
  db._rawDataFromStorage = cloneDbData(db.data);
  db._normalizedKeysOnRead = new Set();
}

async function persistCollectionEntityDelete(db, collection, id) {
  invalidateDbCache();
  ensureDbShapeForWrite(db);
  if (hasCollectionReadNormalization(db, collection)) {
    syncCollectionPersistence(
      collection,
      getStoredCollectionSnapshot(db, collection),
      Array.isArray(db.data?.[collection]) ? db.data[collection] : []
    );
  } else {
    deleteEntity(collection, id);
  }
  setDbCache(db.data);
  db._rawDataFromStorage = cloneDbData(db.data);
  db._normalizedKeysOnRead = new Set();
}

async function persistCollectionEntitiesWrite(db, collection, entities) {
  invalidateDbCache();
  ensureDbShapeForWrite(db);
  if (hasCollectionReadNormalization(db, collection)) {
    syncCollectionPersistence(
      collection,
      getStoredCollectionSnapshot(db, collection),
      Array.isArray(db.data?.[collection]) ? db.data[collection] : []
    );
  } else {
    upsertEntities(collection, entities);
  }
  setDbCache(db.data);
  db._rawDataFromStorage = cloneDbData(db.data);
  db._normalizedKeysOnRead = new Set();
}

async function safeWrite(db) {
  const release = await localMutex.acquire();
  try {
    await persistDbWrite(db);
  } finally {
    release();
  }
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export async function getDb() {
  if (isCloud) {
    if (!dbInstance) {
      const data = cloneDefaultData();
      dbInstance = createMemoryDb(data);
    }
    return dbInstance;
  }

  await ensureSqliteBootstrap();

  if (!dbInstance) {
    dbInstance = createMemoryDb(cloneDefaultData());
  }

  if (hasFreshDbCache()) {
    dbInstance.data = cloneDbData(dbCache);
    // Cache hit shortcut: ensure raw snapshot stays in sync with the live data
    // and clear normalization markers so subsequent persistCollectionEntity*
    // writes don't fall into the full-collection sync branch with a stale
    // _rawDataFromStorage reference.
    dbInstance._rawDataFromStorage = cloneDbData(dbInstance.data);
    dbInstance._normalizedKeysOnRead = new Set();
    return dbInstance;
  }

  await safeRead(dbInstance);

  if (!dbInstance.data) {
    dbInstance.data = cloneDefaultData();
    await safeWrite(dbInstance);
  }

  setDbCache(dbInstance.data);

  return dbInstance;
}

export async function migrateDbShape() {
  const db = await getDb();
  const { data, changed } = ensureDbShape(db.data);
  db.data = data;
  if (changed) {
    await safeWrite(db);
  }
  return db.data;
}

export async function getProviderConnections(filter = {}) {
  const connections = await getProviderConnectionsWithFallback(filter);
  return await mergeConnectionsWithHotState(connections);
}

export async function getProviderNodes(filter = {}) {
  const db = await getDb();
  let nodes = db.data.providerNodes || [];
  if (filter.type) nodes = nodes.filter((node) => node.type === filter.type);
  return nodes;
}

export async function getProviderNodeById(id) {
  const db = await getDb();
  return db.data.providerNodes.find((node) => node.id === id) || null;
}

export async function createProviderNode(data) {
  const db = await getDb();
  let node;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.providerNodes) db.data.providerNodes = [];

    const now = new Date().toISOString();
    node = {
      id: data.id || uuidv4(),
      type: data.type,
      name: data.name,
      prefix: data.prefix,
      apiType: data.apiType,
      baseUrl: data.baseUrl,
      createdAt: now,
      updatedAt: now,
    };

    db.data.providerNodes.push(node);
    await persistDbWrite(db);
  });
  return node;
}

export async function updateProviderNode(id, data) {
  const db = await getDb();
  let result = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.providerNodes) db.data.providerNodes = [];

    const index = db.data.providerNodes.findIndex((node) => node.id === id);
    if (index === -1) return;

    db.data.providerNodes[index] = {
      ...db.data.providerNodes[index],
      ...data,
      updatedAt: new Date().toISOString(),
    };

    await persistDbWrite(db);
    result = db.data.providerNodes[index];
  });
  return result;
}

export async function deleteProviderNode(id) {
  const db = await getDb();
  let removed = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.providerNodes) db.data.providerNodes = [];

    const index = db.data.providerNodes.findIndex((node) => node.id === id);
    if (index === -1) return;

    [removed] = db.data.providerNodes.splice(index, 1);
    await persistDbWrite(db);
  });
  return removed;
}

export async function getProxyPools(filter = {}) {
  const db = await getDb();
  let pools = db.data.proxyPools || [];

  if (filter.isActive !== undefined) pools = pools.filter((pool) => pool.isActive === filter.isActive);
  if (filter.testStatus) pools = pools.filter((pool) => pool.testStatus === filter.testStatus);

  return pools.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export async function getProxyPoolById(id) {
  const db = await getDb();
  return (db.data.proxyPools || []).find((pool) => pool.id === id) || null;
}

export async function createProxyPool(data) {
  const db = await getDb();
  let pool;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.proxyPools) db.data.proxyPools = [];

    const now = new Date().toISOString();
    pool = {
      id: data.id || uuidv4(),
      name: data.name,
      proxyUrl: data.proxyUrl,
      noProxy: data.noProxy || "",
      type: data.type || "http",
      isActive: data.isActive !== undefined ? data.isActive : true,
      strictProxy: data.strictProxy === true,
      testStatus: data.testStatus || "unknown",
      lastTestedAt: data.lastTestedAt || null,
      lastError: data.lastError || null,
      createdAt: now,
      updatedAt: now,
    };

    db.data.proxyPools.push(pool);
    await persistDbWrite(db);
  });
  return pool;
}

export async function updateProxyPool(id, data) {
  const db = await getDb();
  let result = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.proxyPools) db.data.proxyPools = [];

    const index = db.data.proxyPools.findIndex((pool) => pool.id === id);
    if (index === -1) return;

    db.data.proxyPools[index] = {
      ...db.data.proxyPools[index],
      ...data,
      updatedAt: new Date().toISOString(),
    };

    await persistDbWrite(db);
    result = db.data.proxyPools[index];
  });
  return result;
}

export async function deleteProxyPool(id) {
  const db = await getDb();
  let removed = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.proxyPools) db.data.proxyPools = [];

    const index = db.data.proxyPools.findIndex((pool) => pool.id === id);
    if (index === -1) return;

    [removed] = db.data.proxyPools.splice(index, 1);
    await persistDbWrite(db);
  });
  return removed;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getDb();
  let deletedCount = 0;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    const beforeCount = db.data.providerConnections.length;
    db.data.providerConnections = db.data.providerConnections.filter(
      (connection) => connection.provider !== providerId
    );
    deletedCount = beforeCount - db.data.providerConnections.length;
    await persistDbWrite(db);
  });
  if (deletedCount > 0) {
    clearHotStateForProvider(providerId);
    markProviderHotStateInvalidated(providerId);
    await clearProviderHotState(providerId);
  }
  return deletedCount;
}

export async function getProviderConnectionById(id) {
  const db = await getDb();
  const connection = db.data.providerConnections.find(c => c.id === id) || null;
  if (!connection) return null;
  const merged = await mergeConnectionsWithHotState([connection]);
  return merged[0] || connection;
}

export async function createProviderConnection(data) {
  const db = await getDb();
  const normalizedData = stripLegacyMirrorStatusPatch(data || {});

  // Wrap entire upsert logic in local mutex to prevent in-process races.
  let result;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    const now = new Date().toISOString();

    // Upsert: check existing by provider + email (oauth) or provider + name (apikey)
    let existingIndex = -1;
    if (normalizedData.authType === "oauth" && normalizedData.email) {
      existingIndex = db.data.providerConnections.findIndex(
        c => c.provider === normalizedData.provider && c.authType === "oauth" && c.email === normalizedData.email
      );
    } else if (normalizedData.authType === "apikey" && normalizedData.name) {
      existingIndex = db.data.providerConnections.findIndex(
        c => c.provider === normalizedData.provider && c.authType === "apikey" && c.name === normalizedData.name
      );
    }

    if (existingIndex !== -1) {
      db.data.providerConnections[existingIndex] = {
        ...db.data.providerConnections[existingIndex],
        ...normalizedData,
        updatedAt: now,
      };

      if (shouldSeedEligibility(db.data.providerConnections[existingIndex])) {
        Object.assign(db.data.providerConnections[existingIndex], buildEligibilityRecoveryPatch());
      }

      await persistCollectionEntityWrite(db, "providerConnections", db.data.providerConnections[existingIndex]);
      result = db.data.providerConnections[existingIndex];
      return;
    }

    let connectionName = normalizedData.name || normalizedData.email || normalizedData.displayName || null;
    if (!connectionName && normalizedData.authType === "oauth") {
      if (normalizedData.email) {
        connectionName = normalizedData.email;
      } else if (normalizedData.displayName) {
        connectionName = normalizedData.displayName;
      } else {
        const existingCount = db.data.providerConnections.filter(
          c => c.provider === normalizedData.provider
        ).length;
        connectionName = `Account ${existingCount + 1}`;
      }
    }

    let connectionPriority = normalizedData.priority;
    if (!connectionPriority) {
      const providerConnections = db.data.providerConnections.filter(c => c.provider === normalizedData.provider);
      const maxPriority = providerConnections.reduce((max, c) => Math.max(max, c.priority || 0), 0);
      connectionPriority = maxPriority + 1;
    }

    const connection = {
      id: typeof normalizedData.id === "string" && normalizedData.id.trim() ? normalizedData.id : uuidv4(),
      provider: normalizedData.provider,
      authType: normalizedData.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: normalizedData.isActive !== undefined ? normalizedData.isActive : true,
      createdAt: now,
      updatedAt: now,
    };

    if (normalizedData.routingStatus !== undefined) {
      connection.routingStatus = normalizedData.routingStatus;
    }
    if (normalizedData.healthStatus !== undefined) {
      connection.healthStatus = normalizedData.healthStatus;
    }
    if (normalizedData.quotaState !== undefined) {
      connection.quotaState = normalizedData.quotaState;
    }
    if (normalizedData.authState !== undefined) {
      connection.authState = normalizedData.authState;
    }
    if (normalizedData.reasonCode !== undefined) {
      connection.reasonCode = normalizedData.reasonCode;
    }
    if (normalizedData.reasonDetail !== undefined) {
      connection.reasonDetail = normalizedData.reasonDetail;
    }
    if (normalizedData.nextRetryAt !== undefined) {
      connection.nextRetryAt = normalizedData.nextRetryAt;
    }
    if (normalizedData.resetAt !== undefined) {
      connection.resetAt = normalizedData.resetAt;
    }
    if (normalizedData.lastCheckedAt !== undefined) {
      connection.lastCheckedAt = normalizedData.lastCheckedAt;
    }

    const optionalFields = [
      "displayName", "email", "globalPriority", "defaultModel",
      "accessToken", "refreshToken", "expiresAt", "tokenType",
      "scope", "idToken", "projectId", "apiKey",
      "expiresIn", "consecutiveUseCount"
    ];

    for (const field of optionalFields) {
      if (normalizedData[field] !== undefined && normalizedData[field] !== null) {
        connection[field] = normalizedData[field];
      }
    }

    if (normalizedData.providerSpecificData && Object.keys(normalizedData.providerSpecificData).length > 0) {
      connection.providerSpecificData = normalizedData.providerSpecificData;
    }

    if (shouldSeedEligibility(connection)) {
      Object.assign(connection, buildEligibilityRecoveryPatch());
    }

    db.data.providerConnections.push(connection);
    await persistCollectionEntityWrite(db, "providerConnections", connection);
    // Reorder INSIDE the lock to prevent another mutator from observing the
    // half-applied state (H5).
    await reorderProviderConnectionsLocked(db, normalizedData.provider);
    result = connection;
  });

  return result;
}

export async function updateProviderConnection(id, data) {
  const db = await getDb();
  let result = null;

  await withLocalDbMutex(async () => {
    await safeRead(db);

    const index = db.data.providerConnections.findIndex(c => c.id === id);
    if (index === -1) {
      result = null;
      return;
    }

    const providerId = db.data.providerConnections[index].provider;
    const current = db.data.providerConnections[index];
    const sanitizedInput = stripLegacyMirrorStatusPatch(data || {});
    const hotStatePatch = extractHotState(sanitizedInput);
    const hasHotStateUpdates = Object.keys(hotStatePatch).length > 0;
    const dbPatch = Object.fromEntries(
      Object.entries(sanitizedInput).filter(([key]) => !(key in hotStatePatch))
    );
    const shouldStoreHotState = isHotOnlyUpdate(sanitizedInput);
    const canUseRedisForHotState = shouldStoreHotState && await isRedisHotStateReady();

    if (hasHotStateUpdates) {
      const hotStateResult = await setConnectionHotState(id, providerId, hotStatePatch);
      const persistedHotState = hotStateResult?.state || hotStatePatch;

      db.data.providerConnections[index] = stripLegacyMirrorStatusFields({
        ...db.data.providerConnections[index],
        ...dbPatch,
        ...persistedHotState,
        updatedAt: new Date().toISOString(),
      });

      await persistCollectionEntityWrite(db, "providerConnections", db.data.providerConnections[index]);

      if (data.priority !== undefined) await reorderProviderConnectionsLocked(db, providerId);

      if (current && data.isActive === false) {
        await deleteConnectionHotState(id, providerId);
      }

      result = db.data.providerConnections[index];
      return;
    }

    db.data.providerConnections[index] = stripLegacyMirrorStatusFields({
      ...db.data.providerConnections[index],
      ...dbPatch,
      updatedAt: new Date().toISOString(),
    });

    if (shouldSeedEligibility(db.data.providerConnections[index])) {
      Object.assign(db.data.providerConnections[index], buildEligibilityRecoveryPatch());
    }

    if (!canUseRedisForHotState) {
      await persistCollectionEntityWrite(db, "providerConnections", db.data.providerConnections[index]);
    }
    if (data.priority !== undefined) await reorderProviderConnectionsLocked(db, providerId);

    if (current && data.isActive === false) {
      await deleteConnectionHotState(id, providerId);
    }

    result = db.data.providerConnections[index];
  });

  return result;
}

export async function atomicUpdateProviderConnection(id, mutator) {
  const db = await getDb();
  let result = null;

  await withLocalDbMutex(async () => {
    await safeRead(db);

    const index = db.data.providerConnections.findIndex(c => c.id === id);
    if (index === -1) {
      result = null;
      return;
    }

    const current = db.data.providerConnections[index];
    const patch = await mutator({ ...current });
    if (!patch || typeof patch !== "object") {
      result = await mergeConnectionsWithHotState([db.data.providerConnections[index]]).then((connections) => connections[0] || db.data.providerConnections[index]);
      return;
    }

    const providerId = current.provider;
    const sanitizedInput = stripLegacyMirrorStatusPatch(patch);
    const hotStatePatch = extractHotState(sanitizedInput);
    const hasHotStateUpdates = Object.keys(hotStatePatch).length > 0;
    const dbPatch = Object.fromEntries(
      Object.entries(sanitizedInput).filter(([key]) => !(key in hotStatePatch))
    );
    const shouldStoreHotState = isHotOnlyUpdate(sanitizedInput);
    const canUseRedisForHotState = shouldStoreHotState && await isRedisHotStateReady();

    if (hasHotStateUpdates) {
      const hotStateResult = await setConnectionHotState(id, providerId, hotStatePatch);
      const persistedHotState = hotStateResult?.state || hotStatePatch;

      db.data.providerConnections[index] = stripLegacyMirrorStatusFields({
        ...db.data.providerConnections[index],
        ...dbPatch,
        ...persistedHotState,
        updatedAt: new Date().toISOString(),
      });

      await persistDbWrite(db);

      if (patch.priority !== undefined) await reorderProviderConnectionsLocked(db, providerId);

      if (current && patch.isActive === false) {
        await deleteConnectionHotState(id, providerId);
      }

      result = await mergeConnectionsWithHotState([db.data.providerConnections[index]]).then((connections) => connections[0] || db.data.providerConnections[index]);
      return;
    }

    db.data.providerConnections[index] = stripLegacyMirrorStatusFields({
      ...db.data.providerConnections[index],
      ...dbPatch,
      updatedAt: new Date().toISOString(),
    });

    if (shouldSeedEligibility(db.data.providerConnections[index])) {
      Object.assign(db.data.providerConnections[index], buildEligibilityRecoveryPatch());
    }

    if (!canUseRedisForHotState) {
      await persistDbWrite(db);
    }
    if (patch.priority !== undefined) await reorderProviderConnectionsLocked(db, providerId);

    if (current && patch.isActive === false) {
      await deleteConnectionHotState(id, providerId);
    }

    result = await mergeConnectionsWithHotState([db.data.providerConnections[index]]).then((connections) => connections[0] || db.data.providerConnections[index]);
  });

  return result;
}

export async function deleteProviderConnection(id) {
  const db = await getDb();
  let success = false;
  let providerId = null;

  await withLocalDbMutex(async () => {
    await safeRead(db);

    const index = db.data.providerConnections.findIndex(c => c.id === id);
    if (index === -1) {
      success = false;
      return;
    }

    providerId = db.data.providerConnections[index].provider;
    db.data.providerConnections.splice(index, 1);
    await persistCollectionEntityDelete(db, "providerConnections", id);
    await reorderProviderConnectionsLocked(db, providerId);
    success = true;
  });

  if (success && providerId) {
    await deleteConnectionHotState(id, providerId);
  }

  return success;
}

/**
 * Mutex-internal reorder. Assumes the caller already holds the local mutex
 * and has done a fresh `safeRead`. Use this from inside `withLocalDbMutex`
 * blocks to avoid the H5 race where a parallel mutator could observe a
 * half-applied priority update.
 */
async function reorderProviderConnectionsLocked(db, providerId) {
  if (!db.data.providerConnections) return;

  const providerConnections = db.data.providerConnections
    .filter(c => c.provider === providerId)
    .sort((a, b) => {
      const pDiff = (a.priority || 0) - (b.priority || 0);
      if (pDiff !== 0) return pDiff;
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });

  providerConnections.forEach((conn, index) => {
    conn.priority = index + 1;
  });

  await persistCollectionEntitiesWrite(db, "providerConnections", providerConnections);
}

export async function reorderProviderConnections(providerId) {
  const db = await getDb();
  await withLocalDbMutex(async () => {
    await safeRead(db);
    await reorderProviderConnectionsLocked(db, providerId);
  });
}

export async function getModelAliases() {
  const db = await getDb();
  return db.data.modelAliases || {};
}

export async function setModelAlias(alias, model) {
  const db = await getDb();
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.modelAliases) db.data.modelAliases = {};
    db.data.modelAliases[alias] = model;
    await persistDbWrite(db);
  });
}

export async function deleteModelAlias(alias) {
  const db = await getDb();
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.modelAliases) db.data.modelAliases = {};
    delete db.data.modelAliases[alias];
    await persistDbWrite(db);
  });
}

// Custom models — user-added models with explicit type (llm/image/tts/embedding/...)
export async function getCustomModels() {
  const db = await getDb();
  return db.data.customModels || [];
}

export async function addCustomModel({ providerAlias, id, type = "llm", name }) {
  const db = await getDb();
  let added = false;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.customModels) db.data.customModels = [];
    const exists = db.data.customModels.some(
      (m) => m.providerAlias === providerAlias && m.id === id && (m.type || "llm") === type
    );
    if (exists) return;
    db.data.customModels.push({ providerAlias, id, type, name: name || id });
    await persistDbWrite(db);
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  const db = await getDb();
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.customModels) return;
    db.data.customModels = db.data.customModels.filter(
      (m) => !(m.providerAlias === providerAlias && m.id === id && (m.type || "llm") === type)
    );
    await persistDbWrite(db);
  });
}

export async function getMitmAlias(toolName) {
  const db = await getDb();
  const all = db.data.mitmAlias || {};
  if (toolName) return all[toolName] || {};
  return all;
}

export async function setMitmAliasAll(toolName, mappings) {
  const db = await getDb();
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.mitmAlias) db.data.mitmAlias = {};
    db.data.mitmAlias[toolName] = mappings || {};
    await persistSingletonWrite(db, "mitmAlias");
  });
}

export async function setMitmAlias(toolName, mappings) {
  return setMitmAliasAll(toolName, mappings);
}

export async function deleteMitmAlias(toolName) {
  const db = await getDb();
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.mitmAlias) db.data.mitmAlias = {};
    delete db.data.mitmAlias[toolName];
    await persistSingletonWrite(db, "mitmAlias");
  });
}

export async function getCombos() {
  const db = await getDb();
  return db.data.combos || [];
}

export async function getComboById(id) {
  const db = await getDb();
  return (db.data.combos || []).find(c => c.id === id) || null;
}

export async function getComboByName(name) {
  const db = await getDb();
  return (db.data.combos || []).find(c => c.name === name) || null;
}

export async function createCombo(data) {
  const db = await getDb();
  let combo;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.combos) db.data.combos = [];

    const now = new Date().toISOString();
    combo = {
      id: uuidv4(),
      name: data.name,
      models: data.models || [],
      createdAt: now,
      updatedAt: now,
    };

    db.data.combos.push(combo);
    await persistDbWrite(db);
  });
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getDb();
  let result = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.combos) db.data.combos = [];

    const index = db.data.combos.findIndex(c => c.id === id);
    if (index === -1) return;

    db.data.combos[index] = {
      ...db.data.combos[index],
      ...data,
      updatedAt: new Date().toISOString(),
    };

    await persistDbWrite(db);
    result = db.data.combos[index];
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getDb();
  let success = false;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.combos) return;

    const index = db.data.combos.findIndex(c => c.id === id);
    if (index === -1) return;

    db.data.combos.splice(index, 1);
    await persistDbWrite(db);
    success = true;
  });
  return success;
}

export async function getApiKeys() {
  const db = await getDb();
  return db.data.apiKeys || [];
}

function generateShortKey() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");

  const db = await getDb();
  const now = new Date().toISOString();

  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);

  let apiKey;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.apiKeys) db.data.apiKeys = [];
    apiKey = {
      id: uuidv4(),
      name: name,
      key: result.key,
      machineId: machineId,
      isActive: true,
      createdAt: now,
    };

    db.data.apiKeys.push(apiKey);
    await persistDbWrite(db);
  });
  return apiKey;
}

export async function deleteApiKey(id) {
  const db = await getDb();
  let success = false;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.apiKeys) db.data.apiKeys = [];
    const index = db.data.apiKeys.findIndex(k => k.id === id);
    if (index === -1) return;

    db.data.apiKeys.splice(index, 1);
    await persistDbWrite(db);
    success = true;
  });
  return success;
}

export async function getApiKeyById(id) {
  const db = await getDb();
  return db.data.apiKeys.find(k => k.id === id) || null;
}

export async function updateApiKey(id, data) {
  const db = await getDb();
  let result = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.apiKeys) db.data.apiKeys = [];
    const index = db.data.apiKeys.findIndex(k => k.id === id);
    if (index === -1) return;
    db.data.apiKeys[index] = { ...db.data.apiKeys[index], ...data };
    await persistDbWrite(db);
    result = db.data.apiKeys[index];
  });
  return result;
}

export async function validateApiKey(key) {
  const db = await getDb();
  const found = db.data.apiKeys.find(k => k.key === key);
  return found && found.isActive !== false;
}

export async function cleanupProviderConnections() {
  const db = await getDb();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "idToken", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorType", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
    "consecutiveUseCount"
  ];

  let cleaned = 0;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    cleaned = 0;
    for (const connection of db.data.providerConnections) {
      for (const field of fieldsToCheck) {
        if (connection[field] === null || connection[field] === undefined) {
          delete connection[field];
          cleaned++;
        }
      }
      if (connection.providerSpecificData && Object.keys(connection.providerSpecificData).length === 0) {
        delete connection.providerSpecificData;
        cleaned++;
      }
    }

    if (cleaned > 0) await persistDbWrite(db);
  });
  return cleaned;
}

export async function getSettings() {
  const db = await getDb();
  return mergeSettingsWithDefaults(db.data.settings || { cloudEnabled: false });
}

export async function atomicUpdateSettings(mutator) {
  if (typeof mutator !== "function") {
    throw new Error("Settings mutator is required");
  }

  const db = await getDb();
  let result = null;

  await withLocalDbMutex(async () => {
    await safeRead(db);
    const current = mergeSettingsWithDefaults(db.data.settings || { cloudEnabled: false });
    const updated = await mutator(structuredClone(current));

    if (!updated || typeof updated !== "object" || Array.isArray(updated)) {
      throw new Error("Mutator must return settings object");
    }

    db.data.settings = mergeSettingsWithDefaults(updated);
    await persistDbWrite(db);
    result = db.data.settings;
  });

  return result;
}

export async function mutateOpenCodeTokens(mutator) {
  if (typeof mutator !== "function") {
    throw new Error("Token mutator is required");
  }

  const db = await getDb();
  let nextOpenCodeSync = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    db.data.opencodeSync = normalizeOpenCodeSyncDomain(db.data.opencodeSync);
    const current = [...(db.data.opencodeSync.tokens || [])];
    const result = mutator(current);

    if (!result || typeof result !== "object" || !Array.isArray(result.tokens)) {
      throw new Error("Invalid token mutation result");
    }

    db.data.opencodeSync.tokens = [...result.tokens];
    await persistDbWrite(db);
    nextOpenCodeSync = normalizeOpenCodeSyncDomain(db.data.opencodeSync);
  });

  db.data.opencodeSync = normalizeOpenCodeSyncDomain(nextOpenCodeSync || db.data.opencodeSync);
  return db.data.opencodeSync.tokens;
}

export async function touchOpenCodeTokenLastUsedAt(tokenId, usedAt = new Date().toISOString()) {
  const normalizedId = typeof tokenId === "string" ? tokenId.trim() : "";
  if (!normalizedId) {
    throw new Error("Token id is required");
  }

  return mutateOpenCodeTokens((tokens) => ({
    tokens: tokens.map((token) =>
      token?.id === normalizedId
        ? {
            ...token,
            lastUsedAt: usedAt,
            updatedAt: usedAt,
          }
        : token
    ),
  }));
}

export async function updateSettings(updates) {
  const db = await getDb();
  const nextUpdates = updates && typeof updates === "object" && !Array.isArray(updates)
    ? { ...updates }
    : {};

  let result = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    db.data.settings = mergeSettingsWithDefaults({
      ...db.data.settings,
      ...nextUpdates,
      quotaScheduler: {
        ...(db.data.settings?.quotaScheduler || {}),
        ...(nextUpdates?.quotaScheduler || {}),
      },
    });
    await persistDbWrite(db);
    result = db.data.settings;
  });
  return result;
}

function stripHotStateFromConnection(connection) {
  if (!connection || typeof connection !== "object") return connection;
  const cleaned = {};
  for (const [key, value] of Object.entries(connection)) {
    if (isHotStateKey(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export async function exportDb() {
  const db = await getDb();
  const data = db.data || cloneDefaultData();
  const sanitizedConnections = Array.isArray(data.providerConnections)
    ? data.providerConnections.map(stripHotStateFromConnection)
    : [];
  return {
    format: DB_BACKUP_FORMAT,
    schemaVersion: DB_BACKUP_SCHEMA_VERSION,
    ...data,
    providerConnections: sanitizedConnections,
  };
}

export async function importDb(payload) {
  validateDbImportPayload(payload);

  const { format: _format, schemaVersion: _schemaVersion, ...importPayload } = payload;

  const nextData = {
    ...cloneDefaultData(),
    ...importPayload,
    settings: {
      ...cloneDefaultData().settings,
      ...(importPayload.settings && typeof importPayload.settings === "object" && !Array.isArray(importPayload.settings)
        ? importPayload.settings
        : {}),
    },
  };

  nextData.settings = mergeSettingsWithDefaults(nextData.settings);

  const { data: normalized } = ensureDbShape(nextData);
  const db = await getDb();
  const invalidatedProviders = new Set();
  await withLocalDbMutex(async () => {
    await safeRead(db);
    for (const conn of db.data.providerConnections || []) {
      if (conn?.provider) invalidatedProviders.add(conn.provider);
    }
    for (const connection of normalized.providerConnections || []) {
      if (connection?.provider) invalidatedProviders.add(connection.provider);
    }
    db.data = normalized;
    await persistDbWrite(db);
  });
  await clearAllHotState();
  rebuildHotStateFromConnections(db.data.providerConnections || []);
  for (const providerId of invalidatedProviders) {
    markProviderHotStateInvalidated(providerId);
  }
  return db.data;
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  // Cloud URL is now sourced exclusively from settings.cloudUrls. The legacy
  // CLOUD_URL / NEXT_PUBLIC_CLOUD_URL env vars are intentionally ignored so
  // that all configuration lives in the dashboard.
  const settings = await getSettings();
  if (typeof settings.cloudUrl === "string" && settings.cloudUrl) {
    return settings.cloudUrl;
  }
  const first = Array.isArray(settings.cloudUrls)
    ? settings.cloudUrls.find((entry) => typeof entry?.url === "string" && entry.url)
    : null;
  return first?.url ? first.url.replace(/\/$/, "") : "";
}

export async function getPricing() {
  const { PROVIDER_PRICING } = await import("@/shared/constants/pricing.js");

  function mergePricingWithDefaults(userPricing = {}) {
    const merged = {};

    for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
      merged[provider] = { ...models };
      if (userPricing[provider] && typeof userPricing[provider] === "object" && !Array.isArray(userPricing[provider])) {
        for (const [model, pricing] of Object.entries(userPricing[provider])) {
          merged[provider][model] = merged[provider][model]
            ? { ...merged[provider][model], ...pricing }
            : pricing;
        }
      }
    }

    for (const [provider, models] of Object.entries(userPricing)) {
      if (!models || typeof models !== "object" || Array.isArray(models)) continue;

      if (!merged[provider]) {
        merged[provider] = { ...models };
      } else {
        for (const [model, pricing] of Object.entries(models)) {
          if (!merged[provider][model]) merged[provider][model] = pricing;
        }
      }
    }

    return merged;
  }

  const db = await getDb();
  const userPricing = db.data.pricing || {};
  return mergePricingWithDefaults(isPlainObject(userPricing) ? userPricing : {});
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;

  const db = await getDb();
  const userPricing = db.data.pricing || {};

  if (provider && userPricing[provider]?.[model]) {
    return userPricing[provider][model];
  }

  const { getPricingForModel: resolve } = await import("@/shared/constants/pricing.js");
  return resolve(provider, model);
}

export async function updatePricing(pricingData) {
  const db = await getDb();
  let result = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.pricing) db.data.pricing = {};

    for (const [provider, models] of Object.entries(pricingData)) {
      if (!db.data.pricing[provider]) db.data.pricing[provider] = {};
      for (const [model, pricing] of Object.entries(models)) {
        db.data.pricing[provider][model] = pricing;
      }
    }

    await persistDbWrite(db);
    result = db.data.pricing;
  });
  return result;
}

export async function resetPricing(provider, model) {
  const db = await getDb();
  let result = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    if (!db.data.pricing) db.data.pricing = {};

    if (model) {
      if (db.data.pricing[provider]) {
        delete db.data.pricing[provider][model];
        if (Object.keys(db.data.pricing[provider]).length === 0) {
          delete db.data.pricing[provider];
        }
      }
    } else {
      delete db.data.pricing[provider];
    }

    await persistDbWrite(db);
    result = db.data.pricing;
  });
  return result;
}

export async function resetAllPricing() {
  const db = await getDb();
  let result = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    db.data.pricing = {};
    await persistDbWrite(db);
    result = db.data.pricing;
  });
  return result;
}

// --- OpenCode Sync ---

function normalizeOpenCodeSyncDomain(value) {
  const current = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    preferences: normalizeOpenCodePreferences(current.preferences),
    tokens: Array.isArray(current.tokens) ? current.tokens : [],
  };
}

export async function getOpenCodeSync() {
  const db = await getDb();
  db.data.opencodeSync = normalizeOpenCodeSyncDomain(db.data.opencodeSync);
  return db.data.opencodeSync;
}

export async function getOpenCodePreferences() {
  const opencodeSync = await getOpenCodeSync();
  return normalizeOpenCodePreferences(opencodeSync.preferences);
}

export async function updateOpenCodePreferences(updates) {
  const db = await getDb();
  let result = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    db.data.opencodeSync = normalizeOpenCodeSyncDomain(db.data.opencodeSync);

    const current = normalizeOpenCodePreferences(db.data.opencodeSync.preferences);
    db.data.opencodeSync.preferences = validateOpenCodePreferences({
      ...current,
      ...(updates && typeof updates === "object" && !Array.isArray(updates) ? updates : {}),
    });

    await persistDbWrite(db);
    result = db.data.opencodeSync.preferences;
  });
  return result;
}

export async function listOpenCodeTokens() {
  const opencodeSync = await getOpenCodeSync();
  return opencodeSync.tokens;
}

export async function replaceOpenCodeTokens(tokens) {
  const db = await getDb();
  let result = null;
  await withLocalDbMutex(async () => {
    await safeRead(db);
    db.data.opencodeSync = normalizeOpenCodeSyncDomain(db.data.opencodeSync);
    db.data.opencodeSync.tokens = Array.isArray(tokens) ? [...tokens] : [];
    await persistDbWrite(db);
    result = db.data.opencodeSync.tokens;
  });
  return result;
}
