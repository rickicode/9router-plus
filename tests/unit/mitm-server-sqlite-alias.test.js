import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const tempDirs = [];

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-mitm-sqlite-"));
  tempDirs.push(dir);
  return dir;
}

function seedMitmAlias(dataDir, value) {
  const db = new Database(path.join(dataDir, "db.sqlite"));
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
    `);
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("mitmAlias", JSON.stringify(value), Date.now());
  } finally {
    db.close();
  }
}

function loadGetMappedModel(dataDir) {
  const source = fsSync.readFileSync(
    path.join(__dirname, "../../src/mitm/server.js"),
    "utf8"
  );
  const constantBlock = `const fs = require("fs");\nconst Database = require("better-sqlite3");\nconst DB_SQLITE_FILE = ${JSON.stringify(path.join(dataDir, "db.sqlite"))};\n`;
  const start = source.indexOf("function getMappedModel");
  const end = source.indexOf("function saveRequestLog", start);
  const snippet = `${constantBlock}${source.slice(start, end)}\nmodule.exports = { getMappedModel };`;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console,
  };

  vm.runInNewContext(snippet, sandbox, { filename: "mitm-server-getMappedModel.js" });
  return sandbox.module.exports.getMappedModel;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("MITM server SQLite alias lookup", () => {
  it("reads mitm aliases from SQLite without db.json", async () => {
    const dataDir = await createTempDataDir();
    seedMitmAlias(dataDir, {
      antigravity: {
        planner: "anthropic/claude-sonnet-4",
        "gemini-2.5": "google/gemini-2.5-pro",
      },
    });

    const getMappedModel = loadGetMappedModel(dataDir);

    expect(getMappedModel("antigravity", "planner")).toBe("anthropic/claude-sonnet-4");
    expect(getMappedModel("antigravity", "gemini-2.5-flash")).toBe("google/gemini-2.5-pro");
    await expect(fs.access(path.join(dataDir, "db.json"))).rejects.toThrow();
  });
});
