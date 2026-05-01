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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-targeted-writes-"));
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
  const upsertSingletonSpy = vi.spyOn(sqliteHelpers, "upsertSingleton");
   const upsertEntitySpy = vi.spyOn(sqliteHelpers, "upsertEntity");
   const upsertEntitiesSpy = vi.spyOn(sqliteHelpers, "upsertEntities");
   const deleteEntitySpy = vi.spyOn(sqliteHelpers, "deleteEntity");
  const saveAllDataToSqliteSpy = vi.spyOn(sqliteHelpers, "saveAllDataToSqlite");
  const localDb = await import("../../src/lib/localDb.js");

  upsertSingletonSpy.mockClear();
   upsertEntitySpy.mockClear();
   upsertEntitiesSpy.mockClear();
   deleteEntitySpy.mockClear();
  saveAllDataToSqliteSpy.mockClear();

  return {
    localDb,
    sqliteHelpers,
    upsertSingletonSpy,
    upsertEntitySpy,
    upsertEntitiesSpy,
    deleteEntitySpy,
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

describe("localDb targeted singleton writes", () => {
  it("uses targeted SQLite singleton writes for mitmAlias updates", async () => {
    const {
      localDb,
      sqliteHelpers,
      upsertSingletonSpy,
      saveAllDataToSqliteSpy,
    } = await loadModules({
      mitmAlias: {
        planner: { writer: "openai/gpt-4.1" },
      },
    });

    await localDb.setMitmAliasAll("planner", { writer: "anthropic/claude-sonnet-4" });

    expect(upsertSingletonSpy).toHaveBeenCalledWith("mitmAlias", {
      planner: { writer: "anthropic/claude-sonnet-4" },
    });
    expect(saveAllDataToSqliteSpy).not.toHaveBeenCalled();
    expect(sqliteHelpers.loadSingletonFromSqlite("mitmAlias")).toEqual({
      planner: { writer: "anthropic/claude-sonnet-4" },
    });

    upsertSingletonSpy.mockClear();
    saveAllDataToSqliteSpy.mockClear();

    await localDb.deleteMitmAlias("planner");

    expect(upsertSingletonSpy).toHaveBeenCalledWith("mitmAlias", {});
    expect(saveAllDataToSqliteSpy).not.toHaveBeenCalled();
    expect(sqliteHelpers.loadSingletonFromSqlite("mitmAlias")).toEqual({});
  });

  it("uses targeted provider connection upserts and keeps cache coherent", async () => {
    const initialData = {
      providerConnections: [
        {
          id: "conn-1",
          provider: "openai",
          authType: "apikey",
          name: "Primary",
          priority: 1,
          isActive: true,
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
          routingStatus: "eligible",
          healthStatus: "healthy",
          quotaState: "ok",
          authState: "ok",
        },
      ],
    };

    const {
      localDb,
      sqliteHelpers,
      upsertEntitySpy,
      upsertEntitiesSpy,
      deleteEntitySpy,
      saveAllDataToSqliteSpy,
    } = await loadModules(initialData);

    const updated = await localDb.updateProviderConnection("conn-1", {
      name: "Primary Updated",
      isActive: true,
    });

    expect(updated?.name).toBe("Primary Updated");
    expect(upsertEntitySpy).toHaveBeenCalledTimes(1);
    expect(upsertEntitySpy).toHaveBeenCalledWith(
      "providerConnections",
      expect.objectContaining({ id: "conn-1", name: "Primary Updated" })
    );
    expect(upsertEntitiesSpy).not.toHaveBeenCalled();
    expect(deleteEntitySpy).not.toHaveBeenCalled();
    expect(saveAllDataToSqliteSpy).not.toHaveBeenCalled();
    expect(await localDb.getProviderConnections()).toEqual([
      expect.objectContaining({ id: "conn-1", name: "Primary Updated" }),
    ]);
    expect(sqliteHelpers.loadCollectionFromSqlite("providerConnections")).toEqual([
      expect.objectContaining({ id: "conn-1", name: "Primary Updated" }),
    ]);

    upsertEntitySpy.mockClear();
    upsertEntitiesSpy.mockClear();
    deleteEntitySpy.mockClear();
    saveAllDataToSqliteSpy.mockClear();

    const created = await localDb.createProviderConnection({
      id: "conn-2",
      provider: "openai",
      authType: "apikey",
      name: "Secondary",
      isActive: true,
    });

    expect(created?.id).toBe("conn-2");
    expect(upsertEntitySpy).toHaveBeenCalledWith(
      "providerConnections",
      expect.objectContaining({ id: "conn-2", name: "Secondary" })
    );
    expect(upsertEntitiesSpy).toHaveBeenCalledTimes(1);
    expect(upsertEntitiesSpy).toHaveBeenCalledWith(
      "providerConnections",
      expect.arrayContaining([
        expect.objectContaining({ id: "conn-1", priority: 1 }),
        expect.objectContaining({ id: "conn-2", priority: 2 }),
      ])
    );
    expect(deleteEntitySpy).not.toHaveBeenCalled();
    expect(saveAllDataToSqliteSpy).not.toHaveBeenCalled();
    expect(await localDb.getProviderConnections({ provider: "openai" })).toEqual([
      expect.objectContaining({ id: "conn-1", priority: 1 }),
      expect.objectContaining({ id: "conn-2", priority: 2 }),
    ]);

    upsertEntitySpy.mockClear();
    upsertEntitiesSpy.mockClear();
    deleteEntitySpy.mockClear();
    saveAllDataToSqliteSpy.mockClear();

    const deleted = await localDb.deleteProviderConnection("conn-1");

    expect(deleted).toBe(true);
    expect(deleteEntitySpy).toHaveBeenCalledTimes(1);
    expect(deleteEntitySpy).toHaveBeenCalledWith("providerConnections", "conn-1");
    expect(upsertEntitiesSpy).toHaveBeenCalledTimes(1);
    expect(upsertEntitiesSpy).toHaveBeenCalledWith(
      "providerConnections",
      [expect.objectContaining({ id: "conn-2", priority: 1 })]
    );
    expect(saveAllDataToSqliteSpy).not.toHaveBeenCalled();
    expect(await localDb.getProviderConnections({ provider: "openai" })).toEqual([
      expect.objectContaining({ id: "conn-2", priority: 1 }),
    ]);
    expect(sqliteHelpers.loadCollectionFromSqlite("providerConnections")).toEqual([
      expect.objectContaining({ id: "conn-2", priority: 1 }),
    ]);
  });

  it("persists provider connection normalization side effects before targeted writes", async () => {
    const initialData = {
      providerConnections: [
        {
          id: "conn-1",
          provider: "openai",
          authType: "apikey",
          name: "Primary",
          priority: 1,
          isActive: true,
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
        },
        {
          id: "conn-2",
          provider: "openai",
          authType: "apikey",
          name: "Primary",
          priority: 2,
          isActive: true,
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:00.000Z",
        },
      ],
    };

    const {
      localDb,
      sqliteHelpers,
      upsertEntitySpy,
      upsertEntitiesSpy,
      deleteEntitySpy,
      saveAllDataToSqliteSpy,
    } = await loadModules(initialData);

    const updated = await localDb.updateProviderConnection("conn-1", {
      name: "Primary Updated",
      isActive: true,
    });

    expect(updated?.routingStatus).toBe("eligible");
    expect(upsertEntitySpy).not.toHaveBeenCalled();
    expect(upsertEntitiesSpy).toHaveBeenCalledWith(
      "providerConnections",
      [expect.objectContaining({ id: "conn-1", name: "Primary Updated", routingStatus: "eligible" })]
    );
    expect(deleteEntitySpy).toHaveBeenCalledWith("providerConnections", "conn-2");
    expect(saveAllDataToSqliteSpy).not.toHaveBeenCalled();
    expect(await localDb.getProviderConnections({ provider: "openai" })).toEqual([
      expect.objectContaining({ id: "conn-1", name: "Primary Updated", routingStatus: "eligible" }),
    ]);
    expect(sqliteHelpers.loadCollectionFromSqlite("providerConnections")).toEqual([
      expect.objectContaining({ id: "conn-1", name: "Primary Updated", routingStatus: "eligible" }),
    ]);
  });
});
