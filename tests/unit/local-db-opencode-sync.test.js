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
  extractHotState: vi.fn(() => ({})),
  mergeConnectionsWithHotState: vi.fn(async (connections) => connections),
  setConnectionHotState: vi.fn(async () => null),
  isHotOnlyUpdate: vi.fn(() => false),
  isRedisHotStateReady: vi.fn(() => false),
}));

vi.mock("@/lib/opencodeSync/schema.js", async () => {
  const actual = await vi.importActual("../../src/lib/opencodeSync/schema.js");
  return actual;
});

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-opencode-sync-"));
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
  return import("../../src/lib/localDb.js");
}

async function loadSqliteHelpers() {
  sqliteHelpersModule = await import("../../src/lib/sqliteHelpers.js");
  return sqliteHelpersModule;
}

beforeEach(() => {
  sqliteHelpersModule = null;
});

afterEach(async () => {
  if (sqliteHelpersModule?.closeSqliteDb) {
    sqliteHelpersModule.closeSqliteDb();
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

describe("localDb opencodeSync SQLite authority", () => {
  it("reads opencodeSync directly from SQLite when the singleton exists", async () => {
    const localDb = await loadLocalDb({
      opencodeSync: {
        preferences: { variant: "custom", customTemplate: "lowdb" },
        tokens: [{ id: "lowdb-token", label: "Lowdb" }],
      },
    });
    const sqliteHelpers = await loadSqliteHelpers();

    sqliteHelpers.upsertSingleton("opencodeSync", {
      preferences: { variant: "custom", customTemplate: "sqlite" },
      tokens: [{ id: "sqlite-token", label: "SQLite" }],
    });

    await expect(localDb.getOpenCodeSync()).resolves.toEqual({
      preferences: expect.objectContaining({ variant: "custom", customTemplate: "sqlite" }),
      tokens: [{ id: "sqlite-token", label: "SQLite" }],
    });
  });

  it("persists opencodeSync write operations to SQLite", async () => {
    const localDb = await loadLocalDb({ opencodeSync: { preferences: {}, tokens: [] } });
    const { loadSingletonFromSqlite } = await loadSqliteHelpers();

    await localDb.updateOpenCodePreferences({ variant: "custom", customTemplate: "minimal" });
    expect(loadSingletonFromSqlite("opencodeSync")).toMatchObject({
      preferences: expect.objectContaining({ variant: "custom", customTemplate: "minimal" }),
      tokens: [],
    });

    await localDb.replaceOpenCodeTokens([{ id: "token-1", label: "Laptop" }]);
    expect(loadSingletonFromSqlite("opencodeSync")).toMatchObject({
      tokens: [{ id: "token-1", label: "Laptop" }],
    });

    await localDb.mutateOpenCodeTokens((tokens) => ({
      tokens: [...tokens, { id: "token-2", label: "Desktop" }],
    }));
    expect(loadSingletonFromSqlite("opencodeSync")).toMatchObject({
      tokens: [
        { id: "token-1", label: "Laptop" },
        { id: "token-2", label: "Desktop" },
      ],
    });

    await localDb.touchOpenCodeTokenLastUsedAt("token-2", "2026-04-25T00:00:00.000Z");
    expect(loadSingletonFromSqlite("opencodeSync")).toMatchObject({
      tokens: expect.arrayContaining([
        expect.objectContaining({
          id: "token-2",
          lastUsedAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
        }),
      ]),
    });
  });

  it("persists imported opencodeSync data to SQLite", async () => {
    const localDb = await loadLocalDb();
    const { loadSingletonFromSqlite } = await loadSqliteHelpers();

    await localDb.importDb({
      settings: { cloudEnabled: false },
      opencodeSync: {
        preferences: { variant: "custom", customTemplate: "imported" },
        tokens: [{ id: "imported-token" }],
      },
    });

    expect(loadSingletonFromSqlite("opencodeSync")).toMatchObject({
      preferences: expect.objectContaining({ variant: "custom", customTemplate: "imported" }),
      tokens: [{ id: "imported-token" }],
    });
  });
});
