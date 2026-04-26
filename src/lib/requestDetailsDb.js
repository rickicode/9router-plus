import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";

const isCloud = typeof caches !== "undefined" && typeof caches === "object";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024; // 5KB default, configurable via settings
const CONFIG_CACHE_TTL_MS = 5000;
const MAX_TOTAL_DB_SIZE = 50 * 1024 * 1024; // 50MB hard limit for total DB file
const DB_FILE = isCloud ? null : path.join(DATA_DIR, "request-details.json");

if (!isCloud && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let dbInstance = null;

async function getDb() {
  if (isCloud) return null;
  if (!dbInstance) {
    const adapter = new JSONFile(DB_FILE);
    const db = new Low(adapter, { records: [] });
    await db.read();
    if (!db.data?.records) db.data = { records: [] };
    dbInstance = db;
  }
  return dbInstance;
}

// Config cache
let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) {
    return cachedConfig;
  }

  try {
    const { getSettings } = await import("@/lib/localDb");
    const settings = await getSettings();
    const envEnabled = process.env.OBSERVABILITY_ENABLED !== "false";
    const enabled = typeof settings.enableObservability === "boolean"
      ? settings.enableObservability
      : envEnabled;

    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }

  cachedConfigTs = Date.now();
  return cachedConfig;
}

// Batch write queue
let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;
let activeFlushPromise = null;
let activeFlushItems = [];

function buildVisibleRecord(detail) {
  const record = {
    id: detail.id || null,
    provider: detail.provider || null,
    model: detail.model || null,
    connectionId: detail.connectionId || null,
    timestamp: detail.timestamp || null,
    status: detail.status || null,
    latency: detail.latency || {},
    tokens: detail.tokens || {},
    request: detail.request || {},
    providerRequest: detail.providerRequest || {},
    providerResponse: detail.providerResponse || {},
    response: detail.response || {},
  };

  if (record.request?.headers) {
    record.request = {
      ...record.request,
      headers: sanitizeHeaders(record.request.headers),
    };
  }

  return record;
}

function getMergedRecords(persistedRecords = []) {
  const merged = new Map();

  for (const record of persistedRecords) {
    if (record?.id) {
      merged.set(record.id, record);
      continue;
    }
    merged.set(Symbol("persisted-record"), record);
  }

  for (const detail of [...activeFlushItems, ...writeBuffer]) {
    const record = buildVisibleRecord(detail);
    if (record.id) {
      merged.set(record.id, record);
      continue;
    }
    merged.set(Symbol("buffered-record"), record);
  }

  return Array.from(merged.values());
}

function safeJsonStringify(obj, maxSize) {
  try {
    const str = JSON.stringify(obj);
    if (str.length > maxSize) {
      return JSON.stringify({ _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) });
    }
    return str;
  } catch {
    return "{}";
  }
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

async function runFlush(options = {}) {
  if (isCloud || writeBuffer.length === 0) return;

  isFlushing = true;
  // Capture the items we're about to flush. If the flush fails we put them
  // back at the head of writeBuffer so the data is not silently dropped.
  const itemsToSave = [...writeBuffer];
  writeBuffer = [];
  activeFlushItems = itemsToSave;
  let succeeded = false;

  try {
    const db = await getDb();
    const config = await getObservabilityConfig();

    for (const item of itemsToSave) {
      if (!item.id) item.id = generateDetailId(item.model);
      if (!item.timestamp) item.timestamp = new Date().toISOString();
      if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

      // Serialize large fields
      const record = buildVisibleRecord(item);

      // Truncate oversized JSON fields
      const maxSize = config.maxJsonSize;
      for (const field of ["request", "providerRequest", "providerResponse", "response"]) {
        const str = JSON.stringify(record[field]);
        if (str.length > maxSize) {
          record[field] = { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
        }
      }

      // Upsert: replace existing record with same id
      const idx = db.data.records.findIndex(r => r.id === record.id);
      if (idx !== -1) {
        db.data.records[idx] = record;
      } else {
        db.data.records.push(record);
      }
    }

    // Keep only latest maxRecords (sorted by timestamp desc)
    db.data.records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    if (db.data.records.length > config.maxRecords) {
      db.data.records = db.data.records.slice(0, config.maxRecords);
    }

    // Shrink records until total serialized size is within safe limit. We
    // measure each record's individual size once and then use the running
    // total instead of re-serializing the whole DB on every shrink iteration
    // (which was O(N * total_size) before).
    let recordSizes = db.data.records.map((r) => Buffer.byteLength(JSON.stringify(r), "utf8"));
    let runningTotal = recordSizes.reduce((a, b) => a + b, 0);
    // Approximate envelope overhead from JSON.stringify(db.data). For records:[...]
    // wrapper this is tiny but bound it for safety.
    const envelopeBytes = 32;
    while (db.data.records.length > 1 && runningTotal + envelopeBytes > MAX_TOTAL_DB_SIZE) {
      const keep = Math.floor(db.data.records.length / 2);
      const dropped = recordSizes.slice(keep);
      db.data.records = db.data.records.slice(0, keep);
      recordSizes = recordSizes.slice(0, keep);
      runningTotal -= dropped.reduce((a, b) => a + b, 0);
    }

    await db.write();
    succeeded = true;
  } catch (error) {
    console.error("[requestDetailsDb] Batch write failed:", error);
    // Re-queue the in-flight items at the head of the buffer so the next
    // flush attempt can retry them. If the buffer has grown to/past the
    // configured maxRecords meanwhile, drop the oldest items first to keep
    // memory bounded — better to lose the OLDEST observability records than
    // unbounded growth.
    try {
      const config = cachedConfig || { maxRecords: DEFAULT_MAX_RECORDS };
      const merged = [...itemsToSave, ...writeBuffer];
      writeBuffer = merged.length > config.maxRecords ? merged.slice(-config.maxRecords) : merged;
    } catch {
      // never block shutdown / next flush on a re-queue failure
      writeBuffer = [...itemsToSave, ...writeBuffer];
    }
    if (options.propagateError) {
      throw error;
    }
  } finally {
    activeFlushItems = [];
    isFlushing = false;
    if (!succeeded && writeBuffer.length > 0 && !flushTimer && !isCloud) {
      // Schedule a retry on the standard flush cadence so we don't busy-loop.
      const cadence = (cachedConfig?.flushIntervalMs) || DEFAULT_FLUSH_INTERVAL_MS;
      flushTimer = setTimeout(() => {
        flushToDatabase().catch(() => {});
        flushTimer = null;
      }, cadence);
    }
  }
}

async function flushToDatabase(options = {}) {
  if (isCloud) return;

  while (isFlushing && activeFlushPromise) {
    await activeFlushPromise;
  }

  if (writeBuffer.length === 0) return;

  activeFlushPromise = runFlush(options);
  try {
    await activeFlushPromise;
  } finally {
    activeFlushPromise = null;
  }
}

export async function saveRequestDetail(detail, options = {}) {
  if (isCloud) return;

  const config = await getObservabilityConfig();
  if (!config.enabled) return;

  writeBuffer.push(detail);

  const shouldForceFlush = options.forceFlush ?? options.propagateError === true;

  if (writeBuffer.length >= config.batchSize || shouldForceFlush) {
    await flushToDatabase(options);
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushToDatabase().catch(() => {});
      flushTimer = null;
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  if (isCloud) {
    return { details: [], pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0, hasNext: false, hasPrev: false } };
  }

  const db = await getDb();
  let records = getMergedRecords(db.data.records);

  // Apply filters
  if (filter.provider) records = records.filter(r => r.provider === filter.provider);
  if (filter.model) records = records.filter(r => r.model === filter.model);
  if (filter.connectionId) records = records.filter(r => r.connectionId === filter.connectionId);
  if (filter.status) records = records.filter(r => r.status === filter.status);
  if (filter.startDate) records = records.filter(r => new Date(r.timestamp) >= new Date(filter.startDate));
  if (filter.endDate) records = records.filter(r => new Date(r.timestamp) <= new Date(filter.endDate));

  // Sort desc
  records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const totalItems = records.length;
  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const details = records.slice((page - 1) * pageSize, page * pageSize);

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getKnownProviders() {
  if (isCloud) {
    return [];
  }

  const db = await getDb();
  const providerIds = new Set();

  for (const record of getMergedRecords(db.data.records)) {
    if (record?.provider) {
      providerIds.add(record.provider);
    }
  }

  return [...providerIds].sort();
}

export async function getRequestDetailById(id) {
  if (isCloud) return null;

  const db = await getDb();
  return getMergedRecords(db.data.records).find(r => r.id === id) || null;
}

// Graceful shutdown — use named handlers so we can remove them on re-registration
const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0 || activeFlushPromise) await flushToDatabase();
};

const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
};

const SHUTDOWN_HANDLER_REGISTRY_KEY = Symbol.for("9routerPlus.requestDetailsDb.shutdownHandlers");

function getShutdownHandlerRegistry() {
  if (!globalThis[SHUTDOWN_HANDLER_REGISTRY_KEY]) {
    globalThis[SHUTDOWN_HANDLER_REGISTRY_KEY] = {
      beforeExit: null,
      SIGINT: null,
      SIGTERM: null,
    };
  }

  return globalThis[SHUTDOWN_HANDLER_REGISTRY_KEY];
}

const _signalHandlers = {
  SIGINT: async () => {
    try {
      await _shutdownHandler();
    } finally {
      process.exit(SIGNAL_EXIT_CODES.SIGINT);
    }
  },
  SIGTERM: async () => {
    try {
      await _shutdownHandler();
    } finally {
      process.exit(SIGNAL_EXIT_CODES.SIGTERM);
    }
  },
};

function ensureShutdownHandler() {
  if (isCloud) return;

  const registry = getShutdownHandlerRegistry();

  // Remove any previously registered listeners from this module across reloads.
  if (registry.beforeExit) process.off("beforeExit", registry.beforeExit);
  if (registry.SIGINT) process.off("SIGINT", registry.SIGINT);
  if (registry.SIGTERM) process.off("SIGTERM", registry.SIGTERM);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _signalHandlers.SIGINT);
  process.on("SIGTERM", _signalHandlers.SIGTERM);

  registry.beforeExit = _shutdownHandler;
  registry.SIGINT = _signalHandlers.SIGINT;
  registry.SIGTERM = _signalHandlers.SIGTERM;
}

ensureShutdownHandler();
