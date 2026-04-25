import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConnections = [];
const createProviderConnection = vi.fn(async (data) => ({
  id: data.id || `created-${mockConnections.length + 1}`,
  ...data,
}));
const updateProviderConnection = vi.fn(async (id, data) => ({ id, ...data }));
const getProviderConnections = vi.fn(async () => mockConnections);
const tempDirs = [];

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-credentials-backup-"));
  tempDirs.push(dir);
  return dir;
}

async function loadRealLocalDbWithTempDataDir() {
  const dataDir = await createTempDataDir();
  process.env.DATA_DIR = dataDir;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.resetModules();
  vi.doUnmock("@/lib/localDb");

  const localDb = await import("../../src/lib/localDb.js");
  return { dataDir, localDb };
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

function readProviderConnectionsFromSqlite(dataDir) {
  const db = new Database(path.join(dataDir, "db.sqlite"), { readonly: true });
  try {
    return db.prepare("SELECT value FROM entities WHERE collection = ? ORDER BY id")
      .all("providerConnections")
      .map((row) => JSON.parse(row.value));
  } finally {
    db.close();
  }
}

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/localDb", () => ({
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
}));

describe("credentials backup round-trip", () => {
  beforeEach(() => {
    mockConnections.length = 0;
    createProviderConnection.mockClear();
    updateProviderConnection.mockClear();
    getProviderConnections.mockClear();
    getProviderConnections.mockResolvedValue(mockConnections);
  });

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

  it("exports and imports status metadata without losing fields", async () => {
    mockConnections.push({
      id: "conn-1",
      provider: "codex",
      authType: "oauth",
      name: "Account 1",
      isActive: true,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      routingStatus: "blocked",
      authState: "expired",
      reasonCode: "auth_expired",
      reasonDetail: "Token expired",
      lastCheckedAt: "2026-04-20T10:00:00.000Z",
      nextRetryAt: "2026-04-20T11:00:00.000Z",
      providerSpecificData: { sessionId: "seed-1" },
    });

    const { GET: exportGET } = await import("../../src/app/api/credentials/export/route.js");
    const exportResponse = await exportGET();

    expect(exportResponse.status).toBe(200);
    expect(exportResponse.body.entries).toHaveLength(1);
    expect(exportResponse.body.entries[0]).toMatchObject({
      routingStatus: "blocked",
      authState: "expired",
      reasonCode: "auth_expired",
      reasonDetail: "Token expired",
      lastCheckedAt: "2026-04-20T10:00:00.000Z",
      nextRetryAt: "2026-04-20T11:00:00.000Z",
    });

    mockConnections.length = 0;
    getProviderConnections.mockResolvedValue([]);

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");
    const importResponse = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportResponse.body),
    }));

    expect(importResponse.status).toBe(200);
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
    expect(createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      routingStatus: "blocked",
      authState: "expired",
      reasonCode: "auth_expired",
      reasonDetail: "Token expired",
      lastCheckedAt: "2026-04-20T10:00:00.000Z",
      nextRetryAt: "2026-04-20T11:00:00.000Z",
    }));
  });

  it("updates the only matching oauth connection when identity is missing", async () => {
    mockConnections.push({
      id: "conn-1",
      provider: "codex",
      authType: "oauth",
      name: "Account 1",
      accessToken: "old-access",
      routingStatus: "eligible",
      quotaState: "ok",
    });

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");
    const payload = {
      format: "universal-credentials",
      entries: [
        {
          provider: "codex",
          authType: "oauth",
          accessToken: "new-access",
          routingStatus: "blocked",
          authState: "expired",
        },
      ],
    };

    const importResponse = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }));

    expect(importResponse.status).toBe(200);
    expect(updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(updateProviderConnection).toHaveBeenCalledWith("conn-1", expect.objectContaining({
      provider: "codex",
      authType: "oauth",
      accessToken: "new-access",
      routingStatus: "blocked",
      authState: "expired",
    }));
    expect(createProviderConnection).not.toHaveBeenCalled();
  });

  it("defaults restored codex oauth connections to active when status is missing", async () => {
    mockConnections.push({
      id: "conn-1",
      provider: "codex",
      authType: "oauth",
      name: "Account 1",
      accessToken: "old-access",
    });

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");
    const payload = {
      format: "universal-credentials",
      entries: [
        {
          provider: "codex",
          authType: "oauth",
          accessToken: "new-access",
        },
      ],
    };

    const importResponse = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }));

    expect(importResponse.status).toBe(200);
    expect(updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(updateProviderConnection).toHaveBeenCalledWith("conn-1", expect.objectContaining({
      provider: "codex",
      authType: "oauth",
      accessToken: "new-access",
      routingStatus: "eligible",
      quotaState: "ok",
    }));
    expect(createProviderConnection).not.toHaveBeenCalled();
  });

  it("round-trips provider credentials through sqlite-backed export/import routes", async () => {
    const { dataDir, localDb } = await loadRealLocalDbWithTempDataDir();

    const created = await localDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "sqlite@example.com",
      name: "SQLite Account",
      accessToken: "sqlite-access-token",
      refreshToken: "sqlite-refresh-token",
      routingStatus: "blocked",
      authState: "expired",
      reasonCode: "auth_expired",
      reasonDetail: "Token expired",
      lastCheckedAt: "2026-04-20T10:00:00.000Z",
      providerSpecificData: { workspaceId: "ws-1" },
    });

    vi.doUnmock("@/lib/localDb");
    const { GET: exportGET } = await import("../../src/app/api/credentials/export/route.js");
    const exportResponse = await exportGET();

    expect(exportResponse.status).toBe(200);
    expect(exportResponse.body.entries).toHaveLength(1);
    expect(exportResponse.body.entries[0]).toMatchObject({
      id: created.id,
      accessToken: "sqlite-access-token",
      refreshToken: "sqlite-refresh-token",
      routingStatus: "blocked",
      authState: "expired",
      reasonCode: "auth_expired",
      reasonDetail: "Token expired",
      lastCheckedAt: "2026-04-20T10:00:00.000Z",
    });

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");
    const importResponse = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportResponse.body),
    }));

    expect(importResponse.status).toBe(200);
    expect(importResponse.body).toMatchObject({
      success: true,
      created: 0,
      updated: 1,
      imported: 1,
    });
    expect(readProviderConnectionFromSqlite(dataDir, created.id)).toMatchObject({
      id: created.id,
      accessToken: "sqlite-access-token",
      refreshToken: "sqlite-refresh-token",
      routingStatus: "blocked",
      authState: "expired",
      reasonCode: "auth_expired",
      reasonDetail: "Token expired",
      lastCheckedAt: "2026-04-20T10:00:00.000Z",
    });
  });

  it("replace-mode restore deletes sqlite provider credentials missing from the backup", async () => {
    const { dataDir, localDb } = await loadRealLocalDbWithTempDataDir();

    const restored = await localDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "restore@example.com",
      name: "Restore Me",
      accessToken: "old-restore-token",
      routingStatus: "eligible",
      quotaState: "ok",
    });
    const stale = await localDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Delete Me",
      apiKey: "stale-key",
    });

    vi.doUnmock("@/lib/localDb");
    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");
    const importResponse = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        mode: "replace",
        entries: [{
          id: restored.id,
          provider: "codex",
          authType: "oauth",
          email: "restore@example.com",
          accessToken: "new-restore-token",
          routingStatus: "blocked",
          authState: "expired",
        }],
      }),
    }));

    expect(importResponse.status).toBe(200);
    expect(importResponse.body).toMatchObject({
      success: true,
      created: 0,
      updated: 1,
      imported: 1,
      deleted: 1,
    });
    expect(readProviderConnectionFromSqlite(dataDir, restored.id)).toMatchObject({
      id: restored.id,
      accessToken: "new-restore-token",
      routingStatus: "blocked",
      authState: "expired",
    });
    expect(readProviderConnectionFromSqlite(dataDir, stale.id)).toBeNull();
    expect(readProviderConnectionsFromSqlite(dataDir)).toHaveLength(1);
  });
});
