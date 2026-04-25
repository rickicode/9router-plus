import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];
let sqliteHelpersModule = null;

vi.mock("@/lib/dataDir.js", () => ({
  getDataDir: () => process.env.DATA_DIR,
  get DATA_DIR() {
    return process.env.DATA_DIR;
  },
}));

vi.mock("@/lib/connectionStatus.js", () => ({
  getConnectionEffectiveStatus: vi.fn((connection) => connection?.__status || "unknown"),
  getConnectionStatusDetails: vi.fn((connection) => ({
    status: connection?.__status || "unknown",
  })),
}));

vi.mock("@/lib/quotaStateStore.js", () => ({
  clearAllHotState: vi.fn(async () => {}),
  clearProviderHotState: vi.fn(async () => {}),
  deleteConnectionHotState: vi.fn(async () => {}),
  extractHotState: vi.fn(() => null),
  mergeConnectionsWithHotState: vi.fn(async (connections) => connections),
  setConnectionHotState: vi.fn(async () => null),
  isHotOnlyUpdate: vi.fn(() => false),
  isRedisHotStateReady: vi.fn(() => false),
  projectLegacyConnectionState: vi.fn((value) => value || {}),
}));

vi.mock("@/lib/opencodeSync/schema.js", () => ({
  createDefaultOpenCodePreferences: vi.fn(() => ({})),
  normalizeOpenCodePreferences: vi.fn((value) => (value && typeof value === "object" ? value : {})),
  validateOpenCodePreferences: vi.fn((value) => (value && typeof value === "object" ? value : {})),
}));

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-pricing-"));
  tempDirs.push(dir);
  return dir;
}

async function loadSqliteHelpers() {
  vi.resetModules();
  sqliteHelpersModule = await import("../../src/lib/sqliteHelpers.js");
  return sqliteHelpersModule;
}

async function setupDataDir({ jsonData, sqliteData } = {}) {
  const dataDir = await createTempDataDir();
  process.env.DATA_DIR = dataDir;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;

  if (jsonData) {
    await fs.writeFile(path.join(dataDir, "db.json"), JSON.stringify(jsonData, null, 2));
  }

  if (sqliteData) {
    const sqliteHelpers = await loadSqliteHelpers();
    sqliteHelpers.saveAllDataToSqlite(sqliteData);
    sqliteHelpers.closeSqliteDb();
    sqliteHelpersModule = null;
  }
}

async function loadLocalDb(options) {
  await setupDataDir(options);
  vi.resetModules();
  const localDb = await import("../../src/lib/localDb.js");
  const sqliteHelpers = await loadSqliteHelpers();
  return { localDb, sqliteHelpers };
}

beforeEach(() => {
  sqliteHelpersModule = null;
});

afterEach(async () => {
  sqliteHelpersModule?.closeSqliteDb?.();
  sqliteHelpersModule = null;
  delete process.env.DATA_DIR;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("localDb pricing SQLite authority", () => {
  it("prefers SQLite pricing reads and merges default provider pricing", async () => {
    const sqlitePricingData = {
      providerConnections: [],
      providerNodes: [],
      proxyPools: [],
      combos: [],
      apiKeys: [],
      customModels: [],
      settings: { cloudEnabled: false },
      modelAliases: {},
      pricing: {
        gh: {
          "gpt-5.3-codex": { input: 9 },
          "custom-gh-model": { input: 3, output: 4 },
        },
        custom: {
          "sqlite-model": { input: 5, output: 6 },
        },
      },
      mitmAlias: {},
      opencodeSync: {},
    };

    const { localDb, sqliteHelpers } = await loadLocalDb({
      jsonData: {
        pricing: {
          lowdb: {
            "lowdb-model": { input: 1, output: 2 },
          },
        },
      },
      sqliteData: sqlitePricingData,
    });

    const sqlitePricing = sqliteHelpers.loadSingletonFromSqlite("pricing");

    expect(sqlitePricing).toEqual(sqlitePricingData.pricing);

    const pricing = await localDb.getPricing();

    expect(pricing.gh["gpt-5.3-codex"]).toMatchObject({
      input: 9,
      output: 14,
      cached: 0.175,
    });
    expect(pricing.gh["custom-gh-model"]).toEqual({ input: 3, output: 4 });
    expect(pricing.custom["sqlite-model"]).toEqual({ input: 5, output: 6 });
    expect(pricing.lowdb).toBeUndefined();
  });

  it("persists pricing updates and resets to the SQLite pricing singleton", async () => {
    const { localDb, sqliteHelpers } = await loadLocalDb({
      jsonData: { pricing: {} },
    });

    await localDb.updatePricing({
      custom: {
        model: { input: 1, output: 2 },
        other: { input: 3, output: 4 },
      },
    });
    expect(sqliteHelpers.loadSingletonFromSqlite("pricing")).toEqual({
      custom: {
        model: { input: 1, output: 2 },
        other: { input: 3, output: 4 },
      },
    });

    await localDb.resetPricing("custom", "model");
    expect(sqliteHelpers.loadSingletonFromSqlite("pricing")).toEqual({
      custom: {
        other: { input: 3, output: 4 },
      },
    });

    await localDb.resetAllPricing();
    expect(sqliteHelpers.loadSingletonFromSqlite("pricing")).toEqual({});
  });

  it("persists imported pricing to the SQLite pricing singleton", async () => {
    const { localDb, sqliteHelpers } = await loadLocalDb();

    await localDb.importDb({
      format: "9router-db-v1",
      providerConnections: [],
      providerNodes: [],
      proxyPools: [],
      modelAliases: {},
      customModels: [],
      mitmAlias: {},
      combos: [],
      apiKeys: [],
      pricing: {
        custom: {
          imported: { input: 7, output: 8 },
        },
      },
      settings: { cloudEnabled: false },
    });

    expect(sqliteHelpers.loadSingletonFromSqlite("pricing")).toEqual({
      custom: {
        imported: { input: 7, output: 8 },
      },
    });
  });
});
