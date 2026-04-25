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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-tunnel-state-"));
  tempDirs.push(dir);
  return dir;
}

async function pathExists(targetPath) {
  return fs.access(targetPath).then(() => true).catch(() => false);
}

async function loadModules() {
  vi.resetModules();
  const tunnelState = await import("@/lib/tunnel/state.js");
  const sqliteHelpers = await import("@/lib/sqliteHelpers.js");
  return { tunnelState, sqliteHelpers };
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

describe("tunnel state SQLite storage", () => {
  it("persists tunnel state and pids to SQLite without tunnel JSON or pid files", async () => {
    const dataDir = process.env.DATA_DIR;
    const { tunnelState, sqliteHelpers } = await loadModules();

    tunnelState.saveState({ provider: "cloudflare", url: "https://example.trycloudflare.com" });
    tunnelState.savePid(1234);
    tunnelState.saveTailscalePid(5678);

    expect(await pathExists(path.join(dataDir, "db.sqlite"))).toBe(true);
    expect(await pathExists(path.join(dataDir, "tunnel", "state.json"))).toBe(false);
    expect(await pathExists(path.join(dataDir, "tunnel", "cloudflared.pid"))).toBe(false);
    expect(await pathExists(path.join(dataDir, "tunnel", "tailscale.pid"))).toBe(false);
    expect(sqliteHelpers.loadSingletonFromSqlite("tunnelState")).toEqual({
      state: { provider: "cloudflare", url: "https://example.trycloudflare.com" },
      cloudflaredPid: 1234,
      tailscalePid: 5678,
    });

    sqliteHelpers.closeSqliteDb();
    vi.resetModules();
    const reloaded = await import("@/lib/tunnel/state.js");

    expect(reloaded.loadState()).toEqual({ provider: "cloudflare", url: "https://example.trycloudflare.com" });
    expect(reloaded.loadPid()).toBe(1234);
    expect(reloaded.loadTailscalePid()).toBe(5678);

    reloaded.clearPid();
    reloaded.clearTailscalePid();
    reloaded.clearState();

    expect(reloaded.loadState()).toBeNull();
    expect(reloaded.loadPid()).toBeNull();
    expect(reloaded.loadTailscalePid()).toBeNull();
  });
});
