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

vi.mock("@/lib/providerHotState.js", () => ({
  clearAllHotState: vi.fn(async () => {}),
  clearProviderHotState: vi.fn(async () => {}),
  deleteConnectionHotState: vi.fn(async () => {}),
  extractHotState: vi.fn(() => ({})),
  mergeConnectionsWithHotState: vi.fn(async (connections) => connections),
  setConnectionHotState: vi.fn(async () => null),
  isHotOnlyUpdate: vi.fn(() => false),
  isRedisHotStateReady: vi.fn(() => false),
}));

vi.mock("@/lib/opencodeSync/schema.js", () => ({
  createDefaultOpenCodePreferences: vi.fn(() => ({})),
  normalizeOpenCodePreferences: vi.fn((value) => (value && typeof value === "object" ? value : {})),
  validateOpenCodePreferences: vi.fn((value) => (value && typeof value === "object" ? value : {})),
}));

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-full-replace-"));
  tempDirs.push(dir);
  return dir;
}

async function loadModules(initialData) {
  const dataDir = await createTempDataDir();
  process.env.DATA_DIR = dataDir;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;

  if (initialData) {
    await fs.writeFile(path.join(dataDir, "db.json"), JSON.stringify(initialData, null, 2));
  }

  vi.resetModules();
  const sqliteHelpers = await import("../../src/lib/sqliteHelpers.js");
  const saveAllDataToSqliteSpy = vi.spyOn(sqliteHelpers, "saveAllDataToSqlite");
  const localDb = await import("../../src/lib/localDb.js");

  saveAllDataToSqliteSpy.mockClear();

  return {
    localDb,
    sqliteHelpers,
    saveAllDataToSqliteSpy,
  };
}

afterEach(async () => {
  try {
    const { closeSqliteDb } = await import("../../src/lib/sqliteHelpers.js");
    closeSqliteDb();
  } catch {
    // ignore cleanup errors
  }

  delete process.env.DATA_DIR;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.restoreAllMocks();
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("localDb explicit full replace flows", () => {
  it("still uses full snapshot persistence for importDb replacement", async () => {
    const { localDb, sqliteHelpers, saveAllDataToSqliteSpy } = await loadModules({
      providerConnections: [
        {
          id: "conn-before",
          provider: "openai",
          authType: "apikey",
          name: "Before import",
          isActive: true,
          priority: 1,
        },
      ],
      mitmAlias: {
        before: { writer: "openai/gpt-4.1" },
      },
      pricing: {
        legacy: { old: { input: 1, output: 2 } },
      },
    });

    await localDb.importDb({
      format: "9router-db-v1",
      providerConnections: [],
      providerNodes: [],
      proxyPools: [],
      modelAliases: {},
      customModels: [],
      mitmAlias: { imported: { writer: "anthropic/claude-sonnet-4" } },
      combos: [],
      apiKeys: [],
      pricing: {},
      settings: { cloudEnabled: false },
    });

    expect(saveAllDataToSqliteSpy).toHaveBeenCalledTimes(1);
    expect(saveAllDataToSqliteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConnections: [],
        mitmAlias: { imported: { writer: "anthropic/claude-sonnet-4" } },
        pricing: {},
      })
    );
    expect(sqliteHelpers.loadCollectionFromSqlite("providerConnections")).toEqual([]);
    expect(sqliteHelpers.loadSingletonFromSqlite("mitmAlias")).toEqual({
      imported: { writer: "anthropic/claude-sonnet-4" },
    });
    expect(sqliteHelpers.loadSingletonFromSqlite("pricing")).toEqual({});
  });
});
