import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

vi.mock("@/lib/dataDir.js", () => ({
  getDataDir: () => process.env.DATA_DIR,
  get DATA_DIR() {
    return process.env.DATA_DIR;
  },
}));

vi.mock("@/lib/connectionStatus.js", () => ({
  getConnectionEffectiveStatus: vi.fn((connection) => connection?.routingStatus || "unknown"),
  getConnectionStatusDetails: vi.fn((connection) => ({
    status: connection?.routingStatus || "unknown",
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

vi.mock("@/lib/opencodeSync/schema.js", () => ({
  createDefaultOpenCodePreferences: vi.fn(() => ({})),
  normalizeOpenCodePreferences: vi.fn((value) => (value && typeof value === "object" ? value : {})),
  validateOpenCodePreferences: vi.fn((value) => (value && typeof value === "object" ? value : {})),
}));

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-settings-db-route-"));
  tempDirs.push(dir);
  return dir;
}

async function loadModulesFor(dataDir) {
  process.env.DATA_DIR = dataDir;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;

  vi.resetModules();

  const [{ GET, POST }, localDb, sqliteHelpers] = await Promise.all([
    import("../../src/app/api/settings/database/route.js"),
    import("../../src/lib/localDb.js"),
    import("../../src/lib/sqliteHelpers.js"),
  ]);

  return { GET, POST, localDb, sqliteHelpers };
}

async function closeSqlite() {
  try {
    const sqliteHelpers = await import("../../src/lib/sqliteHelpers.js");
    sqliteHelpers.closeSqliteDb();
  } catch (_) {}
}

describe("settings database route SQLite integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.NINE_ROUTER_PROXY_MANAGED;
    delete process.env.NINE_ROUTER_PROXY_URL;
    delete process.env.NINE_ROUTER_NO_PROXY;
  });

  afterEach(async () => {
    await closeSqlite();
    delete process.env.DATA_DIR;
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.NINE_ROUTER_PROXY_MANAGED;
    delete process.env.NINE_ROUTER_PROXY_URL;
    delete process.env.NINE_ROUTER_NO_PROXY;
    vi.resetModules();

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips exported database payload through route handlers with SQLite persistence", async () => {
    const sourceDir = await createTempDataDir();
    const { GET: sourceGet, localDb: sourceLocalDb } = await loadModulesFor(sourceDir);

    await sourceLocalDb.createProviderConnection({
      id: "conn-roundtrip-1",
      provider: "openai",
      authType: "apikey",
      name: "Primary",
      apiKey: "sk-test-123",
      routingStatus: "eligible",
      healthStatus: "healthy",
      quotaState: "ok",
      authState: "ok",
      isActive: true,
    });
    await sourceLocalDb.updateSettings({
      cloudEnabled: true,
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://127.0.0.1:8899",
      outboundNoProxy: "localhost,127.0.0.1",
      quotaExhaustedThresholdPercent: 17,
    });

    const exportResponse = await sourceGet();

    expect(exportResponse.status).toBe(200);
    expect(exportResponse.body.providerConnections).toHaveLength(1);
    const [exportedConnection] = exportResponse.body.providerConnections;
    expect(exportedConnection).toMatchObject({
      provider: "openai",
      authType: "apikey",
      name: "Primary",
    });
    expect(exportResponse.body.settings).toMatchObject({
      cloudEnabled: true,
      outboundProxyUrl: "http://127.0.0.1:8899",
      quotaExhaustedThresholdPercent: 17,
    });

    await closeSqlite();

    const restoredDir = await createTempDataDir();
    const { POST: restorePost, localDb: restoredLocalDb, sqliteHelpers } = await loadModulesFor(restoredDir);

    const importResponse = await restorePost(
      new Request("http://localhost/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exportResponse.body),
      }),
    );

    expect(importResponse.status).toBe(200);
    expect(importResponse.body).toEqual({ success: true });
    expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:8899");
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1");

    expect(await restoredLocalDb.getProviderConnections()).toEqual([
      expect.objectContaining({
        id: exportedConnection.id,
        provider: "openai",
        authType: "apikey",
        name: "Primary",
      }),
    ]);
    expect(await restoredLocalDb.getSettings()).toMatchObject({
      cloudEnabled: true,
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://127.0.0.1:8899",
      quotaExhaustedThresholdPercent: 17,
    });
    expect(sqliteHelpers.loadCollectionFromSqlite("providerConnections")).toEqual([
      expect.objectContaining({
        id: exportedConnection.id,
        provider: "openai",
      }),
    ]);
    expect(sqliteHelpers.loadSingletonFromSqlite("settings")).toMatchObject({
      cloudEnabled: true,
      outboundProxyUrl: "http://127.0.0.1:8899",
      quotaExhaustedThresholdPercent: 17,
    });

    await closeSqlite();

    const { localDb: reloadedLocalDb } = await loadModulesFor(restoredDir);

    await expect(reloadedLocalDb.getProviderConnections()).resolves.toEqual([
      expect.objectContaining({
        id: exportedConnection.id,
        provider: "openai",
        authType: "apikey",
        name: "Primary",
      }),
    ]);
    await expect(reloadedLocalDb.getSettings()).resolves.toMatchObject({
      cloudEnabled: true,
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://127.0.0.1:8899",
      quotaExhaustedThresholdPercent: 17,
    });
  });

  it("includes the explicit DB backup format marker in exports", async () => {
    const dataDir = await createTempDataDir();
    const { GET: getRoute } = await loadModulesFor(dataDir);

    const response = await getRoute();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      format: "9router-db-v1",
    });
  });

  it("rejects credentials backup payloads without mutating SQLite state", async () => {
    const dataDir = await createTempDataDir();
    const { POST, localDb, sqliteHelpers } = await loadModulesFor(dataDir);

    await localDb.createProviderConnection({
      id: "conn-before-invalid-credentials",
      provider: "openai",
      authType: "apikey",
      name: "Keep Me",
      apiKey: "sk-stays",
      isActive: true,
    });
    await localDb.updateSettings({
      cloudEnabled: true,
      quotaExhaustedThresholdPercent: 19,
    });

    const beforeConnections = await localDb.getProviderConnections();
    const beforeSettings = await localDb.getSettings();

    const response = await POST(
      new Request("http://localhost/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "9router-credentials-v1",
          credentials: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/format/i);
    expect(await localDb.getProviderConnections()).toEqual(beforeConnections);
    expect(await localDb.getSettings()).toEqual(beforeSettings);
    expect(sqliteHelpers.loadCollectionFromSqlite("providerConnections")).toEqual(beforeConnections);
    expect(sqliteHelpers.loadSingletonFromSqlite("settings")).toEqual(beforeSettings);
  });

  it("rejects malformed DB payload shapes without mutating SQLite state", async () => {
    const dataDir = await createTempDataDir();
    const { POST, localDb, sqliteHelpers } = await loadModulesFor(dataDir);

    await localDb.createProviderConnection({
      id: "conn-before-invalid-shape",
      provider: "anthropic",
      authType: "apikey",
      name: "Persisted",
      apiKey: "sk-persisted",
      isActive: true,
    });
    await localDb.updateSettings({
      cloudEnabled: false,
      quotaExhaustedThresholdPercent: 23,
    });

    const beforeConnections = await localDb.getProviderConnections();
    const beforeSettings = await localDb.getSettings();

    const response = await POST(
      new Request("http://localhost/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "9router-db-v1",
          providerConnections: {},
          settings: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/providerConnections|settings|payload/i);
    expect(await localDb.getProviderConnections()).toEqual(beforeConnections);
    expect(await localDb.getSettings()).toEqual(beforeSettings);
    expect(sqliteHelpers.loadCollectionFromSqlite("providerConnections")).toEqual(beforeConnections);
    expect(sqliteHelpers.loadSingletonFromSqlite("settings")).toEqual(beforeSettings);
  });

  it("rejects semantically wrong credential-backup keys on DB import without mutation", async () => {
    const dataDir = await createTempDataDir();
    const { POST, localDb, sqliteHelpers } = await loadModulesFor(dataDir);

    await localDb.createProviderConnection({
      id: "conn-before-family-reject",
      provider: "openai",
      authType: "apikey",
      name: "Keep Family",
      apiKey: "sk-family",
      isActive: true,
    });

    const beforeConnections = await localDb.getProviderConnections();
    const beforeSettings = await localDb.getSettings();

    const response = await POST(
      new Request("http://localhost/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "9router-db-v1",
          entries: [],
          credentials: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/unknown|unexpected|entries|credentials/i);
    expect(await localDb.getProviderConnections()).toEqual(beforeConnections);
    expect(await localDb.getSettings()).toEqual(beforeSettings);
    expect(sqliteHelpers.loadCollectionFromSqlite("providerConnections")).toEqual(beforeConnections);
    expect(sqliteHelpers.loadSingletonFromSqlite("settings")).toEqual(beforeSettings);
  });

  it("rejects unknown top-level DB import keys without mutation", async () => {
    const dataDir = await createTempDataDir();
    const { POST, localDb, sqliteHelpers } = await loadModulesFor(dataDir);

    await localDb.createProviderConnection({
      id: "conn-before-unknown-key",
      provider: "anthropic",
      authType: "apikey",
      name: "Keep Unknown",
      apiKey: "sk-unknown",
      isActive: true,
    });

    const beforeConnections = await localDb.getProviderConnections();
    const beforeSettings = await localDb.getSettings();

    const response = await POST(
      new Request("http://localhost/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "9router-db-v1",
          providerConnections: [],
          settings: {},
          unexpectedTopLevel: true,
        }),
      }),
    );
    
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/unknown|unexpected|unexpectedTopLevel/i);
    expect(await localDb.getProviderConnections()).toEqual(beforeConnections);
    expect(await localDb.getSettings()).toEqual(beforeSettings);
    expect(sqliteHelpers.loadCollectionFromSqlite("providerConnections")).toEqual(beforeConnections);
    expect(sqliteHelpers.loadSingletonFromSqlite("settings")).toEqual(beforeSettings);
  });
});
