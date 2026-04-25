import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];
let sqliteHelpersModule = null;

function createFullDataset() {
  return {
    providerConnections: [
      { id: "conn-1", name: "Primary", provider: "openai" },
      { id: "conn-2", name: "Backup", provider: "anthropic" },
    ],
    providerNodes: [{ id: "node-1", name: "Node A", providerConnectionId: "conn-1" }],
    proxyPools: [{ id: "pool-1", name: "Pool A" }],
    combos: [{ id: "combo-1", name: "Combo A", members: ["conn-1"] }],
    apiKeys: [{ id: "key-1", name: "Default", key: "secret" }],
    customModels: [{ id: "model-1", providerAlias: "openai", type: "llm", name: "GPT-X" }],
    settings: { theme: "dark", region: "us" },
    modelAliases: { fast: "gpt-fast" },
    pricing: { openai: { input: 1, output: 2 } },
    mitmAlias: { enabled: true, alias: "lab" },
    opencodeSync: { enabled: true, version: 3 },
    runtimeConfig: { version: 1, redis: { enabled: false, servers: [] } },
    tunnelState: { state: { provider: "cloudflare" }, cloudflaredPid: 1234 },
  };
}

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-sqlite-helpers-"));
  tempDirs.push(dir);
  return dir;
}

async function loadSqliteHelpers() {
  vi.resetModules();
  sqliteHelpersModule = await import("../../src/lib/sqliteHelpers.js");
  return sqliteHelpersModule;
}

beforeEach(async () => {
  process.env.DATA_DIR = await createTempDataDir();
});

afterEach(async () => {
  if (sqliteHelpersModule?.closeSqliteDb) {
    sqliteHelpersModule.closeSqliteDb();
  }

  sqliteHelpersModule = null;
  delete process.env.DATA_DIR;
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("sqliteHelpers contract", () => {
  it("persists hot_state rows with provider and connection indexes", async () => {
    const sqliteHelpers = await loadSqliteHelpers();

    expect(() => sqliteHelpers.upsertHotState("", "conn-1", { routingStatus: "eligible" })).toThrow(
      /provider must be a non-empty string/
    );
    expect(() => sqliteHelpers.upsertHotState("openai", "", { routingStatus: "eligible" })).toThrow(
      /connectionId must be a non-empty string/
    );

    sqliteHelpers.upsertHotState("openai", "conn-1", {
      routingStatus: "eligible",
      quotaState: "ok",
      healthStatus: "healthy",
      authState: "ok",
      reasonCode: "unknown",
      reasonDetail: "ready",
      nextRetryAt: null,
      resetAt: null,
      lastCheckedAt: "2026-04-25T10:00:00.000Z",
      usageSnapshot: { requests: 2 },
      version: 3,
      lastUsedAt: "2026-04-25T10:01:00.000Z",
      consecutiveUseCount: 4,
      backoffLevel: 1,
      expiresIn: 60,
      updatedAt: "2026-04-25T10:02:00.000Z",
      modelLock_gpt_4o: "2026-04-25T10:05:00.000Z",
      apiKey: "secret-api-key",
      accessToken: "secret-access-token",
      provider: "ignored",
      baseUrl: "https://example.com",
    });

    sqliteHelpers.upsertHotState("openai", "conn-empty", {
      apiKey: "secret-only",
      accessToken: "secret-only",
    });

    expect(sqliteHelpers.loadHotStates("openai", ["conn-1", "conn-empty", "missing"])).toEqual({
      "conn-1": {
        routingStatus: "eligible",
        quotaState: "ok",
        healthStatus: "healthy",
        authState: "ok",
        reasonCode: "unknown",
        reasonDetail: "ready",
        nextRetryAt: null,
        resetAt: null,
        lastCheckedAt: "2026-04-25T10:00:00.000Z",
        usageSnapshot: { requests: 2 },
        version: 3,
        lastUsedAt: "2026-04-25T10:01:00.000Z",
        consecutiveUseCount: 4,
        backoffLevel: 1,
        expiresIn: 60,
        updatedAt: "2026-04-25T10:02:00.000Z",
        modelLock_gpt_4o: "2026-04-25T10:05:00.000Z",
      },
    });

    expect(sqliteHelpers.loadProviderHotState("openai")).toEqual({
      "conn-1": {
        routingStatus: "eligible",
        quotaState: "ok",
        healthStatus: "healthy",
        authState: "ok",
        reasonCode: "unknown",
        reasonDetail: "ready",
        nextRetryAt: null,
        resetAt: null,
        lastCheckedAt: "2026-04-25T10:00:00.000Z",
        usageSnapshot: { requests: 2 },
        version: 3,
        lastUsedAt: "2026-04-25T10:01:00.000Z",
        consecutiveUseCount: 4,
        backoffLevel: 1,
        expiresIn: 60,
        updatedAt: "2026-04-25T10:02:00.000Z",
        modelLock_gpt_4o: "2026-04-25T10:05:00.000Z",
      },
    });

    const db = sqliteHelpers.getSqliteDb();
    const row = db.prepare("SELECT provider, connection_id, value FROM hot_state WHERE provider = ? AND connection_id = ?").get(
      "openai",
      "conn-1"
    );
    const storedState = JSON.parse(row.value);

    expect(row.provider).toBe("openai");
    expect(row.connection_id).toBe("conn-1");
    expect(storedState).not.toHaveProperty("apiKey");
    expect(storedState).not.toHaveProperty("accessToken");
    expect(storedState).not.toHaveProperty("baseUrl");

    const indexes = db.prepare("PRAGMA index_list('hot_state')").all();
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["idx_hot_state_provider", "idx_hot_state_updated_at"])
    );
  });

  it("deletes hot_state rows and rebuilds them from provider connections", async () => {
    const sqliteHelpers = await loadSqliteHelpers();

    sqliteHelpers.upsertHotState("openai", "conn-1", {
      routingStatus: "blocked",
      reasonCode: "temporary_failure",
    });
    sqliteHelpers.upsertHotState("openai", "stale", {
      routingStatus: "blocked",
      reasonCode: "stale",
    });
    sqliteHelpers.upsertHotState("anthropic", "conn-2", {
      routingStatus: "eligible",
      quotaState: "ok",
    });

    sqliteHelpers.deleteHotState("openai", "conn-1");
    expect(sqliteHelpers.loadHotStates("openai", ["conn-1", "stale"])).toEqual({
      stale: {
        routingStatus: "blocked",
        reasonCode: "stale",
      },
    });

    sqliteHelpers.rebuildHotStateFromConnections([
      {
        id: "conn-1",
        provider: "openai",
        routingStatus: "eligible",
        quotaState: "ok",
        healthStatus: "healthy",
        authState: "ok",
        reasonCode: "unknown",
        modelLock_gpt_4o: "2026-04-25T10:05:00.000Z",
        apiKey: "should-not-persist",
      },
      {
        id: "conn-2",
        provider: "anthropic",
        routingStatus: "blocked",
        reasonCode: "cooldown",
        updatedAt: "2026-04-25T10:06:00.000Z",
        accessToken: "should-not-persist",
      },
      {
        id: "conn-3",
        provider: "openai",
        apiKey: "secret-only",
      },
    ]);

    expect(sqliteHelpers.loadProviderHotState("openai")).toEqual({
      "conn-1": {
        routingStatus: "eligible",
        quotaState: "ok",
        healthStatus: "healthy",
        authState: "ok",
        reasonCode: "unknown",
        modelLock_gpt_4o: "2026-04-25T10:05:00.000Z",
      },
    });
    expect(sqliteHelpers.loadProviderHotState("anthropic")).toEqual({
      "conn-2": {
        routingStatus: "blocked",
        reasonCode: "cooldown",
        updatedAt: "2026-04-25T10:06:00.000Z",
      },
    });

    sqliteHelpers.clearHotStateForProvider("openai");
    expect(sqliteHelpers.loadProviderHotState("openai")).toEqual({});

    sqliteHelpers.clearAllSqliteHotState();
    expect(sqliteHelpers.loadProviderHotState("anthropic")).toEqual({});
  });

  it("migrateFromJSON({ preserveJson: false }) migrates db.json into db.sqlite, creates a backup, and preserves data", async () => {
    const data = createFullDataset();
    const dataDir = process.env.DATA_DIR;
    const jsonPath = path.join(dataDir, "db.json");

    await fs.writeFile(jsonPath, JSON.stringify(data, null, 2));

    const sqliteHelpers = await loadSqliteHelpers();
    sqliteHelpers.migrateFromJSON({ preserveJson: false });

    await expect(fs.access(sqliteHelpers.DB_SQLITE_FILE)).resolves.toBeUndefined();
    await expect(fs.access(path.join(dataDir, "db.json.backup"))).resolves.toBeUndefined();
    await expect(fs.access(jsonPath)).rejects.toThrow();

    expect(sqliteHelpers.loadAllDataFromSqlite()).toEqual(data);
  });

  it("saveAllDataToSqlite() persists a full dataset", async () => {
    const data = createFullDataset();
    const sqliteHelpers = await loadSqliteHelpers();

    sqliteHelpers.saveAllDataToSqlite(data);

    expect(sqliteHelpers.loadAllDataFromSqlite()).toEqual(data);
  });

  it("opens SQLite in WAL journal mode", async () => {
    const sqliteHelpers = await loadSqliteHelpers();
    const db = sqliteHelpers.getSqliteDb();

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("upsertEntity() updates a single collection row", async () => {
    const data = createFullDataset();
    const sqliteHelpers = await loadSqliteHelpers();

    sqliteHelpers.saveAllDataToSqlite(data);
    sqliteHelpers.upsertEntity("providerConnections", {
      id: "conn-1",
      name: "Primary Updated",
      provider: "openai",
      enabled: false,
    });

    const rows = sqliteHelpers.loadCollectionFromSqlite("providerConnections");
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          id: "conn-1",
          name: "Primary Updated",
          provider: "openai",
          enabled: false,
        },
        data.providerConnections[1],
      ])
    );
  });

  it("upsertSingleton() updates a singleton row", async () => {
    const data = createFullDataset();
    const sqliteHelpers = await loadSqliteHelpers();

    sqliteHelpers.saveAllDataToSqlite(data);
    sqliteHelpers.upsertSingleton("settings", { theme: "light", region: "eu" });

    expect(sqliteHelpers.loadSingletonFromSqlite("settings")).toEqual({
      theme: "light",
      region: "eu",
    });
  });

  it("deleteEntity() deletes a single collection row", async () => {
    const data = createFullDataset();
    const sqliteHelpers = await loadSqliteHelpers();

    sqliteHelpers.saveAllDataToSqlite(data);
    sqliteHelpers.deleteEntity("providerConnections", "conn-1");

    expect(sqliteHelpers.loadCollectionFromSqlite("providerConnections")).toEqual([
      data.providerConnections[1],
    ]);
  });

  it("saveAllDataToSqlite() removes stale singleton rows omitted from the next dataset", async () => {
    const data = createFullDataset();
    const sqliteHelpers = await loadSqliteHelpers();

    sqliteHelpers.saveAllDataToSqlite(data);
    const nextData = { ...data };
    delete nextData.pricing;

    sqliteHelpers.saveAllDataToSqlite(nextData);

    expect(sqliteHelpers.loadSingletonFromSqlite("pricing")).toBeNull();
  });

  it("migrateFromJSON() verifies all collections before removing the legacy json", async () => {
    const data = createFullDataset();
    const dataDir = process.env.DATA_DIR;
    const jsonPath = path.join(dataDir, "db.json");

    await fs.writeFile(jsonPath, JSON.stringify({
      ...data,
      customModels: [{ name: "missing-id", providerAlias: "openai" }],
    }, null, 2));

    const sqliteHelpers = await loadSqliteHelpers();

    expect(() => sqliteHelpers.migrateFromJSON({ preserveJson: false })).toThrow(/customModels/);
    expect(fsSync.existsSync(jsonPath)).toBe(true);
    expect(fsSync.existsSync(path.join(dataDir, "db.json.backup"))).toBe(false);
  });
});
