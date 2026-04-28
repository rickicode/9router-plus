import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";
import fs from "fs";
import { DATA_DIR } from "@/lib/dataDir.js";

const isCloud = typeof caches !== "undefined" && typeof caches === "object";
const DB_FILE = isCloud ? null : path.join(DATA_DIR, "morph-usage.json");

if (!isCloud && fs && typeof fs.existsSync === "function") {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (error) {
    console.error("[morphUsageDb] Failed to create data directory:", error.message);
  }
}

const defaultData = {
  history: [],
  totalRequestsLifetime: 0,
  dailySummary: {},
};

const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

const MORPH_PRICING = Object.freeze({
  "morph-v3-fast": { input: 0.8, output: 1.2 },
  "morph-v3-large": { input: 0.9, output: 1.9 },
  "morph-warp-grep-v2.1": { input: 0.8, output: 0.8 },
  "morph-compactor": { input: 0.2, output: 0.5 },
  "morph-embedding-v4": { input: 0.18, output: 0 },
  "morph-rerank-v4": { input: 0.1, output: 0 },
});

export const MORPH_CAPABILITY_DEFAULT_MODELS = Object.freeze({
  apply: "morph-v3-large",
  warpgrep: "morph-warp-grep-v2.1",
  compact: "morph-compactor",
  embeddings: "morph-embedding-v4",
  rerank: "morph-rerank-v4",
});

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getDailySummaryBucketTime(dateKey) {
  const parts = String(dateKey).split("-");
  if (parts.length !== 3) return NaN;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return NaN;
  return new Date(year, month - 1, day).getTime();
}

function getPeriodStart(period, nowMs) {
  const duration = PERIOD_MS[period];
  return typeof duration === "number" ? nowMs - duration : null;
}

function isTimestampInPeriod(timestamp, period, nowMs) {
  const entryTime = new Date(timestamp).getTime();
  if (!Number.isFinite(entryTime) || entryTime > nowMs) return false;
  const periodStart = getPeriodStart(period, nowMs);
  if (periodStart === null) return true;
  return entryTime >= periodStart;
}

function normalizeMorphTokens(tokens = {}) {
  const inputTokens = Number(tokens.prompt_tokens ?? tokens.input_tokens ?? 0) || 0;
  const outputTokens = Number(tokens.completion_tokens ?? tokens.output_tokens ?? 0) || 0;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

function resolveMorphPricing(capability, model) {
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (normalizedModel && MORPH_PRICING[normalizedModel]) {
    return { model: normalizedModel, pricing: MORPH_PRICING[normalizedModel] };
  }

  const fallbackModel = MORPH_CAPABILITY_DEFAULT_MODELS[capability] || "";
  return {
    model: fallbackModel,
    pricing: MORPH_PRICING[fallbackModel] || null,
  };
}

export function getDefaultMorphModel(capability) {
  return MORPH_CAPABILITY_DEFAULT_MODELS[capability] || null;
}

export function calculateMorphCredits({ capability, model, tokens }) {
  const normalizedTokens = normalizeMorphTokens(tokens);
  const { model: resolvedModel, pricing } = resolveMorphPricing(capability, model);
  if (!pricing) {
    return { model: resolvedModel || model || null, dollars: 0, credits: 0 };
  }

  const inputCost = (normalizedTokens.input_tokens * pricing.input) / 1000000;
  const outputCost = (normalizedTokens.output_tokens * pricing.output) / 1000000;
  const dollars = inputCost + outputCost;
  const credits = dollars / 0.00001;

  return {
    model: resolvedModel || model || null,
    dollars: Number(dollars.toFixed(10)),
    credits: Number(credits.toFixed(4)),
  };
}

function addToCounter(target, key, values, meta = {}) {
  if (!target[key]) {
    target[key] = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      credits: 0,
      ...meta,
    };
  }

  target[key].requests += values.requests || 0;
  target[key].inputTokens += values.inputTokens || 0;
  target[key].outputTokens += values.outputTokens || 0;
  target[key].credits += values.credits || 0;
}

function aggregateEntryToDailySummary(dailySummary, entry) {
  const dateKey = getLocalDateKey(entry.timestamp);
  if (!dailySummary[dateKey]) {
    dailySummary[dateKey] = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      credits: 0,
      byCapability: {},
      byModel: {},
      byApiKey: {},
      byEntrypoint: {},
    };
  }

  const day = dailySummary[dateKey];
  day.byCapability ||= {};
  day.byModel ||= {};
  day.byApiKey ||= {};
  day.byEntrypoint ||= {};
  const inputTokens = entry.tokens?.input_tokens || entry.tokens?.prompt_tokens || 0;
  const outputTokens = entry.tokens?.output_tokens || entry.tokens?.completion_tokens || 0;
  const values = {
    requests: 1,
    inputTokens,
    outputTokens,
    credits: entry.credits || 0,
  };

  day.requests += values.requests;
  day.inputTokens += values.inputTokens;
  day.outputTokens += values.outputTokens;
  day.credits += values.credits;

  addToCounter(day.byCapability, entry.capability || "unknown", values, {
    capability: entry.capability || "unknown",
  });
  addToCounter(day.byModel, entry.model || "unknown", values, {
    model: entry.model || "unknown",
  });
  addToCounter(day.byApiKey, entry.apiKeyLabel || "Unknown email", values, {
    apiKeyLabel: entry.apiKeyLabel || "Unknown email",
  });
  addToCounter(day.byEntrypoint, entry.entrypoint || "unknown", values, {
    entrypoint: entry.entrypoint || "unknown",
  });
}

export function maskMorphApiKey(apiKey) {
  if (typeof apiKey !== "string") return "Unknown email";
  const trimmed = apiKey.trim();
  if (!trimmed) return "Unknown email";
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

let dbInstance = null;
let morphWriteQueue = Promise.resolve();

function enqueueMorphWrite(task) {
  const run = morphWriteQueue.then(task, task);
  morphWriteQueue = run.catch(() => {});
  return run;
}

export async function getMorphUsageDb() {
  if (isCloud) {
    if (!dbInstance) {
      dbInstance = new Low({ read: async () => {}, write: async () => {} }, defaultData);
      dbInstance.data = structuredClone(defaultData);
    }
    return dbInstance;
  }

  if (!dbInstance) {
    const adapter = new JSONFile(DB_FILE);
    dbInstance = new Low(adapter, defaultData);

    try {
      await dbInstance.read();
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.warn("[morphUsageDb] Corrupt Morph usage JSON detected, resetting to defaults...");
        dbInstance.data = structuredClone(defaultData);
        await dbInstance.write();
      } else {
        throw error;
      }
    }

    if (!dbInstance.data) {
      dbInstance.data = structuredClone(defaultData);
      await dbInstance.write();
    }
  }

  return dbInstance;
}

export async function saveMorphUsage(entry, options = {}) {
  if (isCloud) return null;

  try {
    return await enqueueMorphWrite(async () => {
      const db = await getMorphUsageDb();
      const timestamp = entry.timestamp || new Date().toISOString();
      const tokens = normalizeMorphTokens(entry.tokens);
      const pricing = calculateMorphCredits({
        capability: entry.capability,
        model: entry.model,
        tokens,
      });

      const record = {
        provider: "morph",
        status: entry.status || "ok",
        timestamp,
        capability: entry.capability || "unknown",
        entrypoint: entry.entrypoint || "unknown",
        source: entry.source || "unknown",
        method: entry.method || "POST",
        model: pricing.model || entry.model || null,
        requestedModel: entry.requestedModel || entry.model || null,
        apiKeyLabel: entry.apiKeyLabel || maskMorphApiKey(entry.apiKey),
        upstreamStatus: entry.upstreamStatus ?? null,
        credits: pricing.credits,
        dollars: pricing.dollars,
        tokens,
        error: entry.error || null,
      };

      if (!Array.isArray(db.data.history)) db.data.history = [];
      if (typeof db.data.totalRequestsLifetime !== "number") db.data.totalRequestsLifetime = 0;
      if (!db.data.dailySummary) db.data.dailySummary = {};

      db.data.history.push(record);
      db.data.totalRequestsLifetime += 1;
      aggregateEntryToDailySummary(db.data.dailySummary, record);

      const MAX_HISTORY = 5000;
      if (db.data.history.length > MAX_HISTORY) {
        db.data.history.splice(0, db.data.history.length - MAX_HISTORY);
      }

      await db.write();
      return record;
    });
  } catch (error) {
    console.error("[morphUsageDb] Failed to save Morph usage:", error);
    if (options.propagateError) throw error;
    return null;
  }
}

function buildRecentRequests(history, limit) {
  return [...history]
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .slice(0, limit)
    .map((entry) => ({
      timestamp: entry.timestamp,
      capability: entry.capability,
      entrypoint: entry.entrypoint,
      source: entry.source,
      method: entry.method,
      model: entry.model,
      requestedModel: entry.requestedModel,
      apiKeyLabel: entry.apiKeyLabel || "Unknown email",
      inputTokens: entry.tokens?.input_tokens || entry.tokens?.prompt_tokens || 0,
      outputTokens: entry.tokens?.output_tokens || entry.tokens?.completion_tokens || 0,
      credits: entry.credits || 0,
      status: entry.status || "ok",
      upstreamStatus: entry.upstreamStatus,
      error: entry.error || null,
    }));
}

export async function getMorphRecentRequests(limit = 100) {
  const db = await getMorphUsageDb();
  await db.read();
  const history = db.data.history || [];
  return buildRecentRequests(history, limit);
}

export async function getMorphUsageStats(period = "7d") {
  const db = await getMorphUsageDb();
  await db.read();
  const history = db.data.history || [];
  const dailySummary = db.data.dailySummary || {};
  const nowMs = Date.now();

  const stats = {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCredits: 0,
    totalRequestsLifetime: db.data.totalRequestsLifetime || history.length,
    byCapability: {},
    byModel: {},
    byApiKey: {},
    byEntrypoint: {},
    recentRequests: buildRecentRequests(history, 20),
  };

  if (period === "24h") {
    for (const entry of history) {
      if (!isTimestampInPeriod(entry.timestamp, period, nowMs)) continue;
      const inputTokens = entry.tokens?.input_tokens || entry.tokens?.prompt_tokens || 0;
      const outputTokens = entry.tokens?.output_tokens || entry.tokens?.completion_tokens || 0;
      const values = { requests: 1, inputTokens, outputTokens, credits: entry.credits || 0 };
      stats.totalRequests += 1;
      stats.totalInputTokens += inputTokens;
      stats.totalOutputTokens += outputTokens;
      stats.totalCredits += entry.credits || 0;
      addToCounter(stats.byCapability, entry.capability || "unknown", values, { capability: entry.capability || "unknown" });
      addToCounter(stats.byModel, entry.model || "unknown", values, { model: entry.model || "unknown" });
      addToCounter(stats.byApiKey, entry.apiKeyLabel || "Unknown email", values, { apiKeyLabel: entry.apiKeyLabel || "Unknown email" });
      addToCounter(stats.byEntrypoint, entry.entrypoint || "unknown", values, { entrypoint: entry.entrypoint || "unknown" });
    }

    return stats;
  }

  const periodStart = getPeriodStart(period, nowMs);
  for (const [dateKey, day] of Object.entries(dailySummary)) {
    const dayTime = getDailySummaryBucketTime(dateKey);
    if (!Number.isFinite(dayTime) || dayTime > nowMs) continue;
    if (periodStart !== null && dayTime < periodStart) continue;

    stats.totalRequests += day.requests || 0;
    stats.totalInputTokens += day.inputTokens || 0;
    stats.totalOutputTokens += day.outputTokens || 0;
    stats.totalCredits += day.credits || 0;

    for (const [key, value] of Object.entries(day.byCapability || {})) {
      addToCounter(stats.byCapability, key, value, { capability: value.capability || key });
    }
    for (const [key, value] of Object.entries(day.byModel || {})) {
      addToCounter(stats.byModel, key, value, { model: value.model || key });
    }
    for (const [key, value] of Object.entries(day.byApiKey || {})) {
      addToCounter(stats.byApiKey, key, value, { apiKeyLabel: value.apiKeyLabel || key });
    }
    for (const [key, value] of Object.entries(day.byEntrypoint || {})) {
      addToCounter(stats.byEntrypoint, key, value, { entrypoint: value.entrypoint || key });
    }
  }

  return stats;
}
