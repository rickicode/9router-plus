import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];
let dataDir = null;
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-custom-models-"));
  tempDirs.push(dir);
  return dir;
}

async function writeDbJson(initialData) {
  await fs.writeFile(path.join(dataDir, "db.json"), JSON.stringify(initialData, null, 2));
}

async function importModules() {
  vi.resetModules();
  sqliteHelpersModule = await import("../../src/lib/sqliteHelpers.js");
  sqliteHelpersModule.ensureSchema(sqliteHelpersModule.getSqliteDb());
  const localDb = await import("../../src/lib/localDb.js");
  return { localDb, sqliteHelpers: sqliteHelpersModule };
}

beforeEach(async () => {
  dataDir = await createTempDataDir();
  process.env.DATA_DIR = dataDir;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
});

afterEach(async () => {
  if (sqliteHelpersModule?.closeSqliteDb) {
    sqliteHelpersModule.closeSqliteDb();
  }

  sqliteHelpersModule = null;
  dataDir = null;
  delete process.env.DATA_DIR;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("localDb customModels SQLite authority", () => {
  it("persists custom model writes through SQLite-backed storage", async () => {
    const customModel = {
      providerAlias: "writer",
      id: "writer-model",
      type: "llm",
      name: "Writer",
    };

    await writeDbJson({ customModels: [] });

    let { localDb, sqliteHelpers } = await importModules();

    await expect(localDb.addCustomModel(customModel)).resolves.toBe(true);
    expect(sqliteHelpers.loadCollectionFromSqlite("customModels")).toEqual([customModel]);

    sqliteHelpers.closeSqliteDb();
    sqliteHelpersModule = null;

    ({ localDb, sqliteHelpers } = await importModules());

    await expect(localDb.getCustomModels()).resolves.toEqual([customModel]);

    await expect(
      localDb.deleteCustomModel({
        providerAlias: "writer",
        id: "writer-model",
        type: "llm",
      })
    ).resolves.toBeUndefined();
    expect(sqliteHelpers.loadCollectionFromSqlite("customModels")).toEqual([]);

    sqliteHelpers.closeSqliteDb();
    sqliteHelpersModule = null;

    ({ localDb } = await importModules());

    await expect(localDb.getCustomModels()).resolves.toEqual([]);
  });
});
