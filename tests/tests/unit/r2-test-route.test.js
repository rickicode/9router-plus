import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-r2-test-"));
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
  return import("../../../src/lib/localDb.js");
}

function buildRequest() {
  return { json: async () => ({}) };
}

function buildConfig(overrides = {}) {
  return {
    accountId: "acct",
    accessKeyId: "key",
    secretAccessKey: "secret",
    bucket: "media",
    endpoint: "https://example.r2.cloudflarestorage.com",
    region: "auto",
    publicUrl: "https://cdn.example.com",
    connected: false,
    lastCheckedAt: null,
    lastError: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
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

describe("/api/r2/test route", () => {
  it("POST persists successful connection validation state", async () => {
    const localDb = await loadLocalDb({
      settings: {
        r2Config: buildConfig(),
      },
    });
    const route = await import("../../../src/app/api/r2/test/route.js");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ buckets: [] }),
    })));

    const response = await route.POST(buildRequest());
    const payload = await response.json();
    const settings = await localDb.getSettings();
    const [, request] = fetch.mock.calls[0];

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(request.method).toBe("GET");
    expect(request.headers.Authorization).toContain("AWS4-HMAC-SHA256 Credential=key/");
    expect(request.headers).toHaveProperty("x-amz-date");
    expect(request.headers).toHaveProperty("x-amz-content-sha256");
    expect(request.headers).not.toHaveProperty("X-Auth-Key");
    expect(request.headers).not.toHaveProperty("X-Auth-Secret");
    expect(payload.r2Config).toMatchObject({
      connected: true,
      lastError: "",
    });
    expect(typeof payload.r2Config.lastCheckedAt).toBe("string");
    expect(settings.r2Config).toMatchObject({
      connected: true,
      lastError: "",
    });
    expect(typeof settings.r2Config.lastCheckedAt).toBe("string");
  });

  it("POST persists failed connection validation state without clearing credentials", async () => {
    const localDb = await loadLocalDb({
      settings: {
        r2Config: buildConfig(),
      },
    });
    const route = await import("../../../src/app/api/r2/test/route.js");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ error: "Invalid access key" }),
    })));

    const response = await route.POST(buildRequest());
    const payload = await response.json();
    const settings = await localDb.getSettings();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      error: "R2 request failed (403): Invalid access key",
      success: false,
    });
    expect(settings.r2Config).toMatchObject({
      accountId: "acct",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "media",
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
      publicUrl: "https://cdn.example.com",
      connected: false,
      lastError: "R2 request failed (403): Invalid access key",
    });
    expect(typeof settings.r2Config.lastCheckedAt).toBe("string");
  });

  it("POST rejects missing required R2 config", async () => {
    const localDb = await loadLocalDb({
      settings: {
        r2Config: buildConfig({ bucket: "" }),
      },
    });
    const route = await import("../../../src/app/api/r2/test/route.js");

    const response = await route.POST(buildRequest());
    const payload = await response.json();
    const settings = await localDb.getSettings();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: "Missing required R2 configuration fields: bucket",
      success: false,
    });
    expect(settings.r2Config).toMatchObject({
      connected: false,
      lastError: "Missing required R2 configuration fields: bucket",
      accountId: "acct",
      accessKeyId: "key",
      secretAccessKey: "secret",
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
      publicUrl: "https://cdn.example.com",
    });
    expect(typeof settings.r2Config.lastCheckedAt).toBe("string");
  });
});
