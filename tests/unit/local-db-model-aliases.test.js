import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];

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

vi.mock("@/lib/providerHotState.js", () => ({
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-model-aliases-"));
  tempDirs.push(dir);
  return dir;
}

async function loadLocalDb(initialData) {
  const dataDir = await createTempDataDir();
  process.env.DATA_DIR = dataDir;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;

  if (initialData) {
    await fs.writeFile(path.join(dataDir, "db.json"), JSON.stringify(initialData, null, 2));
  }

  vi.resetModules();
  const [localDb, sqliteHelpers] = await Promise.all([
    import("../../src/lib/localDb.js"),
    import("../../src/lib/sqliteHelpers.js"),
  ]);

  return {
    dataDir,
    localDb,
    sqliteHelpers,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("localDb modelAliases SQLite authority", () => {
  it("stores and deletes model aliases in SQLite", async () => {
    const { localDb, sqliteHelpers } = await loadLocalDb({
      modelAliases: {},
    });

    await localDb.setModelAlias("writer", "openai/gpt-4.1");

    await expect(localDb.getModelAliases()).resolves.toEqual({
      writer: "openai/gpt-4.1",
    });
    expect(sqliteHelpers.loadSingletonFromSqlite("modelAliases")).toEqual({
      writer: "openai/gpt-4.1",
    });

    await localDb.deleteModelAlias("writer");

    await expect(localDb.getModelAliases()).resolves.toEqual({});
    expect(sqliteHelpers.loadSingletonFromSqlite("modelAliases")).toEqual({});
  });

  it("writes imported model aliases to SQLite", async () => {
    const { localDb, sqliteHelpers } = await loadLocalDb();

    await localDb.importDb({
      format: "9router-db-v1",
      providerConnections: [],
      providerNodes: [],
      proxyPools: [],
      modelAliases: { planner: "anthropic/claude-sonnet-4" },
      customModels: [],
      mitmAlias: {},
      combos: [],
      apiKeys: [],
      pricing: {},
      settings: { cloudEnabled: false },
    });

    await expect(localDb.getModelAliases()).resolves.toEqual({
      planner: "anthropic/claude-sonnet-4",
    });
    expect(sqliteHelpers.loadSingletonFromSqlite("modelAliases")).toEqual({
      planner: "anthropic/claude-sonnet-4",
    });
  });
});
