import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];

vi.mock("@/lib/dataDir.js", () => ({
  getDataDir: () => process.env.DATA_DIR,
  get DATA_DIR() { return process.env.DATA_DIR; },
}));

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-runtime-config-"));
  tempDirs.push(dir);
  return dir;
}

async function pathExists(targetPath) {
  return fs.access(targetPath).then(() => true).catch(() => false);
}

async function loadModules() {
  vi.resetModules();
  const runtimeConfig = await import("@/lib/runtimeConfig.js");
  const sqliteHelpers = await import("@/lib/sqliteHelpers.js");
  return { runtimeConfig, sqliteHelpers };
}

beforeEach(async () => {
  process.env.DATA_DIR = await createTempDataDir();
});

afterEach(async () => {
  try {
    const sqliteHelpers = await import("@/lib/sqliteHelpers.js");
    sqliteHelpers.closeSqliteDb();
  } catch (_) {}

  delete process.env.DATA_DIR;
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("runtimeConfig SQLite storage", () => {
  it("persists runtime config to SQLite without runtime-config.json", async () => {
    const dataDir = process.env.DATA_DIR;
    const { runtimeConfig, sqliteHelpers } = await loadModules();

    const written = await runtimeConfig.writeRuntimeConfig({
      version: 1,
      settings: {
        featureFlag: true,
        mode: "production",
      },
    });

    expect(await pathExists(path.join(dataDir, "db.sqlite"))).toBe(true);
    expect(await pathExists(path.join(dataDir, "runtime-config.json"))).toBe(false);
    expect(sqliteHelpers.loadSingletonFromSqlite("runtimeConfig")).toEqual(written);

    sqliteHelpers.closeSqliteDb();
    vi.resetModules();
    const reloaded = await import("@/lib/runtimeConfig.js");

    expect(await reloaded.readRuntimeConfig()).toEqual(written);
  });
});
