import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];
let sqliteHelpersModule = null;

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-sqlite-import-validation-"));
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
  sqliteHelpersModule?.closeSqliteDb?.();
  sqliteHelpersModule = null;
  delete process.env.DATA_DIR;
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("sqlite import validation", () => {
  it("rejects collection records missing id before persistence", async () => {
    const sqliteHelpers = await loadSqliteHelpers();

    expect(() => sqliteHelpers.saveAllDataToSqlite({
      providerConnections: [{ name: "missing-id" }],
      settings: { mitmAlias: "demo" },
    })).toThrow(/providerConnections\[0\].*missing id/i);
  });

  it("preserves valid import behavior", async () => {
    const sqliteHelpers = await loadSqliteHelpers();
    const data = {
      providerConnections: [{ id: "conn-1", name: "Primary", provider: "openai" }],
      providerNodes: [{ id: "node-1", providerConnectionId: "conn-1" }],
      proxyPools: [],
      combos: [],
      apiKeys: [],
      customModels: [],
      settings: { theme: "dark" },
      modelAliases: {},
      pricing: {},
      mitmAlias: {},
      opencodeSync: { enabled: true },
      runtimeConfig: { version: 1 },
      tunnelState: { state: { provider: "cloudflare" } },
    };

    sqliteHelpers.saveAllDataToSqlite(data);

    expect(sqliteHelpers.loadAllDataFromSqlite()).toEqual(data);
  });

  it("accepts singleton-only imports without requiring collection arrays", async () => {
    const sqliteHelpers = await loadSqliteHelpers();
    const data = {
      settings: { theme: "dark", mitmAlias: "demo" },
      modelAliases: { fast: "gpt-4.1-mini" },
      pricing: { openai: { input: 1 } },
      mitmAlias: { current: "demo" },
      opencodeSync: { enabled: true },
      runtimeConfig: { version: 1 },
      tunnelState: { state: { provider: "cloudflare" } },
    };

    sqliteHelpers.saveAllDataToSqlite(data);

    expect(sqliteHelpers.loadAllDataFromSqlite()).toEqual({
      providerConnections: [],
      providerNodes: [],
      proxyPools: [],
      combos: [],
      apiKeys: [],
      customModels: [],
      ...data,
    });
  });

  it("migrateFromJSON rejects malformed collection records before creating sqlite artifacts", async () => {
    const sqliteHelpers = await loadSqliteHelpers();
    const dbJsonPath = path.join(process.env.DATA_DIR, "db.json");
    const dbSqlitePath = path.join(process.env.DATA_DIR, "db.sqlite");

    await fs.writeFile(dbJsonPath, JSON.stringify({
      providerConnections: [{ id: "conn-1", provider: "openai" }, { provider: "anthropic" }],
      settings: { theme: "dark" },
    }));

    expect(() => sqliteHelpers.migrateFromJSON()).toThrow(
      /Migration failed: Invalid providerConnections\[1\]: missing id/i,
    );

    await expect(fs.readFile(dbJsonPath, "utf-8")).resolves.toContain("anthropic");
    await expect(fs.stat(dbSqlitePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${dbSqlitePath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${dbSqlitePath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrateFromJSON leaves no partial sqlite rows when a collection record is non-object", async () => {
    const sqliteHelpers = await loadSqliteHelpers();
    const dbJsonPath = path.join(process.env.DATA_DIR, "db.json");
    const dbSqlitePath = path.join(process.env.DATA_DIR, "db.sqlite");

    await fs.writeFile(dbJsonPath, JSON.stringify({
      providerConnections: [{ id: "conn-1", provider: "openai" }],
      providerNodes: [null],
      settings: { theme: "dark" },
      runtimeConfig: { version: 1 },
    }));

    expect(() => sqliteHelpers.migrateFromJSON()).toThrow(
      /Migration failed: Invalid providerNodes\[0\]: missing id/i,
    );

    await expect(fs.stat(dbSqlitePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${dbSqlitePath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${dbSqlitePath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(dbJsonPath, "utf-8")).resolves.toContain("conn-1");
  });

  it("migrateFromJSON still imports valid JSON data", async () => {
    const sqliteHelpers = await loadSqliteHelpers();
    const dbJsonPath = path.join(process.env.DATA_DIR, "db.json");

    const data = {
      providerConnections: [{ id: "conn-1", name: "Primary", provider: "openai" }],
      providerNodes: [{ id: "node-1", providerConnectionId: "conn-1" }],
      proxyPools: [],
      combos: [],
      apiKeys: [],
      customModels: [],
      settings: { theme: "dark" },
      modelAliases: {},
      pricing: {},
      mitmAlias: {},
      opencodeSync: { enabled: true },
      runtimeConfig: { version: 1 },
      tunnelState: { state: { provider: "cloudflare" } },
    };

    await fs.writeFile(dbJsonPath, JSON.stringify(data));

    expect(sqliteHelpers.migrateFromJSON()).toEqual({ migrated: true });
    expect(sqliteHelpers.loadAllDataFromSqlite()).toEqual(data);
    await expect(fs.readFile(dbJsonPath, "utf-8")).resolves.toContain("conn-1");
  });
});
