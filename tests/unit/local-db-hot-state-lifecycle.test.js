import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { afterEach, describe, expect, it, vi } from "vitest";
import { DB_BACKUP_FORMAT } from "../../src/lib/localDb.js";

const tempDirs = [];

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-hot-state-"));
  tempDirs.push(dir);
  return dir;
}

async function loadModulesWithTempDataDir() {
  const dataDir = await createTempDataDir();
  process.env.DATA_DIR = dataDir;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.resetModules();

  const providerHotState = await import("../../src/lib/providerHotState.js");
  const localDb = await import("../../src/lib/localDb.js");

  providerHotState.__resetProviderHotStateForTests();

  return { dataDir, localDb, providerHotState };
}

function readProviderConnectionFromSqlite(dataDir, id) {
  const db = new Database(path.join(dataDir, "db.sqlite"), { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM entities WHERE collection = ? AND id = ?")
      .get("providerConnections", id);

    return row ? JSON.parse(row.value) : null;
  } finally {
    db.close();
  }
}

function createFakeRedisClient() {
  const hashes = new Map();

  return {
    isReady: true,
    async hGetAll(key) {
      return { ...(hashes.get(key) || {}) };
    },
    async hSet(key, payload) {
      hashes.set(key, {
        ...(hashes.get(key) || {}),
        ...(payload || {}),
      });
    },
    async hDel(key, field) {
      const current = { ...(hashes.get(key) || {}) };
      delete current[field];
      if (Object.keys(current).length === 0) hashes.delete(key);
      else hashes.set(key, current);
    },
    async expire() {
      return true;
    },
    async del(key) {
      hashes.delete(key);
    },
  };
}

afterEach(async () => {
  try {
    const sqliteHelpers = await import("@/lib/sqliteHelpers.js");
    sqliteHelpers.closeSqliteDb();
  } catch (_) {}

  delete process.env.DATA_DIR;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("localDb hot-state lifecycle", () => {
  it("rebuilds sqlite hot state from imported provider connections", async () => {
    const { localDb, providerHotState } = await loadModulesWithTempDataDir();
    const sqliteHelpers = await import("@/lib/sqliteHelpers.js");

    await localDb.createProviderConnection({
      id: "conn-import",
      provider: "provider-import",
      name: "Before import",
      apiKey: "secret",
      isActive: true,
      priority: 1,
      testStatus: "active",
    });

    await providerHotState.setConnectionHotState("conn-import", "provider-import", {
      routingStatus: "blocked_auth",
      authState: "expired",
      quotaState: "exhausted",
      testStatus: "unavailable",
      lastError: "stale overlay",
    });

    await localDb.importDb({
      format: DB_BACKUP_FORMAT,
      providerConnections: [
        {
          id: "conn-import",
          provider: "provider-import",
          name: "Imported",
          apiKey: "imported-secret",
          isActive: true,
          priority: 1,
          routingStatus: "blocked",
          quotaState: "exhausted",
          reasonDetail: "imported quota block",
          usageSnapshot: { remaining: 0 },
          modelLock_gpt4: true,
          testStatus: "active",
        },
      ],
    });

    expect(providerHotState.__getProviderHotStateSnapshotForTests("provider-import")).toBeNull();
    providerHotState.__resetProviderHotStateForTests();

    const importedConnection = await localDb.getProviderConnectionById("conn-import");
    expect(sqliteHelpers.loadProviderHotState("provider-import")).toEqual({
      "conn-import": {
        routingStatus: "blocked",
        quotaState: "exhausted",
        reasonDetail: "imported quota block",
        usageSnapshot: { remaining: 0 },
        modelLock_gpt4: true,
      },
    });

    expect(importedConnection).toMatchObject({
      id: "conn-import",
      provider: "provider-import",
      name: "Imported",
      testStatus: "active",
      routingStatus: "blocked",
      quotaState: "exhausted",
      reasonDetail: "imported quota block",
      usageSnapshot: { remaining: 0 },
      modelLock_gpt4: true,
    });
    expect(sqliteHelpers.loadProviderHotState("provider-import")["conn-import"]).not.toHaveProperty("apiKey");
  });

  it("removes sqlite hot state when deleting a single provider connection", async () => {
    const { localDb, providerHotState } = await loadModulesWithTempDataDir();
    const sqliteHelpers = await import("@/lib/sqliteHelpers.js");

    const created = await localDb.createProviderConnection({
      provider: "provider-delete-single",
      name: "Delete single",
      apiKey: "key-single",
      isActive: true,
      priority: 1,
      testStatus: "active",
    });

    await providerHotState.setConnectionHotState(created.id, "provider-delete-single", {
      routingStatus: "blocked",
      authState: "expired",
      reasonDetail: "single delete",
    });

    expect(sqliteHelpers.loadHotStates("provider-delete-single", [created.id])).toEqual({
      [created.id]: {
        routingStatus: "blocked",
        authState: "expired",
        reasonDetail: "single delete",
      },
    });

    await expect(localDb.deleteProviderConnection(created.id)).resolves.toBe(true);
    providerHotState.__resetProviderHotStateForTests();

    expect(sqliteHelpers.loadHotStates("provider-delete-single", [created.id])).toEqual({});
    await expect(localDb.getProviderConnectionById(created.id)).resolves.toBeNull();
  });

  it("clears provider sqlite hot state when deleting provider connections in bulk", async () => {
    const { localDb, providerHotState } = await loadModulesWithTempDataDir();
    const sqliteHelpers = await import("@/lib/sqliteHelpers.js");

    const createdOne = await localDb.createProviderConnection({
      provider: "provider-delete",
      name: "Delete one",
      apiKey: "key-1",
      isActive: true,
      priority: 1,
      testStatus: "active",
    });
    const createdTwo = await localDb.createProviderConnection({
      provider: "provider-delete",
      name: "Delete two",
      apiKey: "key-2",
      isActive: true,
      priority: 2,
      testStatus: "active",
    });

    await providerHotState.setConnectionHotState(createdOne.id, "provider-delete", {
      routingStatus: "blocked_quota",
      quotaState: "exhausted",
      testStatus: "unavailable",
    });
    await providerHotState.setConnectionHotState(createdTwo.id, "provider-delete", {
      routingStatus: "blocked_health",
      reasonDetail: "stale health",
      testStatus: "error",
    });

    expect(sqliteHelpers.loadProviderHotState("provider-delete")).toEqual({
      [createdOne.id]: {
        quotaState: "exhausted",
      },
      [createdTwo.id]: {
        reasonDetail: "stale health",
      },
    });

    await expect(localDb.deleteProviderConnectionsByProvider("provider-delete")).resolves.toBe(2);
    providerHotState.__resetProviderHotStateForTests();

    expect(providerHotState.__getProviderHotStateSnapshotForTests("provider-delete")).toBeNull();
    expect(sqliteHelpers.loadProviderHotState("provider-delete")).toEqual({});
    await expect(localDb.getProviderConnections({ provider: "provider-delete" })).resolves.toEqual([]);
  });

  it("prevents stale Redis provider state from resurrecting deleted hot state after redis recovers", async () => {
    const { localDb, providerHotState } = await loadModulesWithTempDataDir();
    const sqliteHelpers = await import("@/lib/sqliteHelpers.js");

    process.env.REDIS_URL = "redis://example.test:6379";

    const staleRedis = createFakeRedisClient();
    providerHotState.__setRedisClientForTests(staleRedis);

    const created = await localDb.createProviderConnection({
      provider: "provider-resurrection-delete",
      name: "Delete after outage",
      apiKey: "key-delete",
      isActive: true,
      priority: 1,
      testStatus: "active",
    });

    await providerHotState.setConnectionHotState(created.id, "provider-resurrection-delete", {
      routingStatus: "blocked",
      reasonDetail: "stale redis copy",
    });

    delete process.env.REDIS_URL;

    await expect(localDb.deleteProviderConnection(created.id)).resolves.toBe(true);
    expect(sqliteHelpers.loadProviderHotState("provider-resurrection-delete")).toEqual({});

    providerHotState.__resetProviderHotStateForTests();
    process.env.REDIS_URL = "redis://example.test:6379";
    providerHotState.__setRedisClientForTests(staleRedis);

    const projected = await providerHotState.getConnectionHotStates([
      { id: created.id, provider: "provider-resurrection-delete", testStatus: "active" },
    ]);

    expect(projected.get(`provider-resurrection-delete:${created.id}`)).toMatchObject({
      id: created.id,
      provider: "provider-resurrection-delete",
      testStatus: "active",
    });
    expect(projected.get(`provider-resurrection-delete:${created.id}`)).not.toHaveProperty("routingStatus");

    providerHotState.__resetProviderHotStateForTests();
    providerHotState.__setRedisClientForTests(staleRedis);

    const projectedAgain = await providerHotState.getConnectionHotStates([
      { id: created.id, provider: "provider-resurrection-delete", testStatus: "active" },
    ]);

    expect(projectedAgain.get(`provider-resurrection-delete:${created.id}`)).toMatchObject({
      id: created.id,
      provider: "provider-resurrection-delete",
      testStatus: "active",
    });
    expect(projectedAgain.get(`provider-resurrection-delete:${created.id}`)).not.toHaveProperty("routingStatus");
  });

  it("prevents stale Redis provider state from resurrecting import-invalidated hot state after redis recovers", async () => {
    const { localDb, providerHotState } = await loadModulesWithTempDataDir();

    process.env.REDIS_URL = "redis://example.test:6379";

    const staleRedis = createFakeRedisClient();
    providerHotState.__setRedisClientForTests(staleRedis);

    const created = await localDb.createProviderConnection({
      id: "conn-import-stale",
      provider: "provider-import-stale",
      name: "Before import",
      apiKey: "old-key",
      isActive: true,
      priority: 1,
      testStatus: "active",
    });

    await providerHotState.setConnectionHotState(created.id, "provider-import-stale", {
      routingStatus: "blocked",
      reasonDetail: "stale redis state",
    });

    delete process.env.REDIS_URL;

    await localDb.importDb({
      format: DB_BACKUP_FORMAT,
      providerConnections: [
        {
          id: "conn-import-stale",
          provider: "provider-import-stale",
          name: "Imported clean",
          apiKey: "new-key",
          isActive: true,
          priority: 1,
          routingStatus: "blocked",
          reasonDetail: "imported truth",
          testStatus: "active",
        },
      ],
    });

    providerHotState.__resetProviderHotStateForTests();
    process.env.REDIS_URL = "redis://example.test:6379";
    providerHotState.__setRedisClientForTests(staleRedis);

    const imported = await localDb.getProviderConnectionById("conn-import-stale");

    expect(imported).toMatchObject({
      id: "conn-import-stale",
      provider: "provider-import-stale",
      name: "Imported clean",
      routingStatus: "blocked",
      reasonDetail: "imported truth",
      testStatus: "active",
    });

    providerHotState.__resetProviderHotStateForTests();
    providerHotState.__setRedisClientForTests(staleRedis);

    const importedAgain = await localDb.getProviderConnectionById("conn-import-stale");

    expect(importedAgain).toMatchObject({
      id: "conn-import-stale",
      provider: "provider-import-stale",
      name: "Imported clean",
      routingStatus: "blocked",
      reasonDetail: "imported truth",
      testStatus: "active",
    });
  });

  it("durably persists projected legacy fallback fields for redis-backed hot-only updates", async () => {
    const { dataDir, localDb, providerHotState } = await loadModulesWithTempDataDir();

    process.env.REDIS_URL = "redis://example.test:6379";
    providerHotState.__setRedisClientForTests(createFakeRedisClient());

    const created = await localDb.createProviderConnection({
      provider: "provider-redis-fallback",
      name: "Redis fallback",
      apiKey: "secret",
      isActive: true,
      priority: 1,
      testStatus: "active",
    });

    await localDb.updateProviderConnection(created.id, {
      routingStatus: "blocked_auth",
      authState: "expired",
      reasonDetail: "Authentication expired",
    });

    expect(readProviderConnectionFromSqlite(dataDir, created.id)).toMatchObject({
      id: created.id,
      authState: "expired",
      reasonDetail: "Authentication expired",
    });

    providerHotState.__resetProviderHotStateForTests();
    delete process.env.REDIS_URL;

    const recovered = await localDb.getProviderConnectionById(created.id);
    expect(recovered).toMatchObject({
      id: created.id,
      provider: "provider-redis-fallback",
      authState: "expired",
      reasonDetail: "Authentication expired",
    });
  });

  it("writes mixed updates to both centralized hot state and persisted db fields", async () => {
    const { dataDir, localDb, providerHotState } = await loadModulesWithTempDataDir();

    process.env.REDIS_URL = "redis://example.test:6379";
    providerHotState.__setRedisClientForTests(createFakeRedisClient());

    const created = await localDb.createProviderConnection({
      provider: "provider-mixed-update",
      name: "Before mixed update",
      apiKey: "old-secret",
      isActive: true,
      priority: 1,
      testStatus: "active",
    });

    await localDb.updateProviderConnection(created.id, {
      apiKey: "new-secret",
      name: "After mixed update",
      routingStatus: "exhausted",
      quotaState: "exhausted",
      nextRetryAt: "2026-04-22T12:00:00.000Z",
    });

    expect(providerHotState.__getProviderHotStateSnapshotForTests("provider-mixed-update")).toMatchObject({
      connections: {
        [created.id]: expect.objectContaining({
          routingStatus: "exhausted",
          quotaState: "exhausted",
          nextRetryAt: "2026-04-22T12:00:00.000Z",
        }),
      },
    });

    expect(readProviderConnectionFromSqlite(dataDir, created.id)).toMatchObject({
      id: created.id,
      name: "After mixed update",
      apiKey: "new-secret",
      routingStatus: "exhausted",
      quotaState: "exhausted",
      nextRetryAt: "2026-04-22T12:00:00.000Z",
    });
  });
});
