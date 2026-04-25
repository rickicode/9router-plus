import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-mitm-alias-"));
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
  const sqliteHelpers = await import("../../src/lib/sqliteHelpers.js");
  const localDb = await import("../../src/lib/localDb.js");
  return { localDb, sqliteHelpers };
}

afterEach(async () => {
  try {
    const { closeSqliteDb } = await import("../../src/lib/sqliteHelpers.js");
    closeSqliteDb();
  } catch {
    // no sqlite instance created in this test
  }

  delete process.env.DATA_DIR;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("localDb mitmAlias SQLite authority", () => {
  it("persists setMitmAlias into SQLite and reads it back via getMitmAlias", async () => {
    const { localDb, sqliteHelpers } = await loadLocalDb({ mitmAlias: {} });

    await localDb.setMitmAlias("antigravity", { writer: "openai/gpt-4.1" });

    await expect(localDb.getMitmAlias()).resolves.toEqual({
      antigravity: { writer: "openai/gpt-4.1" },
    });
    await expect(localDb.getMitmAlias("antigravity")).resolves.toEqual({
      writer: "openai/gpt-4.1",
    });
    expect(sqliteHelpers.loadSingletonFromSqlite("mitmAlias")).toEqual({
      antigravity: { writer: "openai/gpt-4.1" },
    });
  });

  it("deleteMitmAlias removes the entry and leaves SQLite singleton empty", async () => {
    const { localDb, sqliteHelpers } = await loadLocalDb({ mitmAlias: {} });

    await localDb.setMitmAlias("antigravity", { writer: "openai/gpt-4.1" });
    await localDb.deleteMitmAlias("antigravity");

    await expect(localDb.getMitmAlias()).resolves.toEqual({});
    await expect(localDb.getMitmAlias("antigravity")).resolves.toEqual({});
    expect(sqliteHelpers.loadSingletonFromSqlite("mitmAlias")).toEqual({});
  });

  it("refreshes SQLite mitmAlias during importDb", async () => {
    const { localDb, sqliteHelpers } = await loadLocalDb();

    await localDb.importDb({
      providerConnections: [],
      providerNodes: [],
      proxyPools: [],
      modelAliases: {},
      customModels: [],
      mitmAlias: { antigravity: { planner: "anthropic/claude-sonnet-4" } },
      combos: [],
      apiKeys: [],
      pricing: {},
      settings: { cloudEnabled: false },
    });

    expect(sqliteHelpers.loadSingletonFromSqlite("mitmAlias")).toEqual({
      antigravity: { planner: "anthropic/claude-sonnet-4" },
    });
  });
});
