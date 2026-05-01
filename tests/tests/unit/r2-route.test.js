import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];

const cloudWorkerClientMocks = vi.hoisted(() => ({
  registerWithWorker: vi.fn(async () => ({ success: true })),
}));

vi.mock("@/lib/cloudWorkerClient.js", () => cloudWorkerClientMocks);

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-r2-settings-"));
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

afterEach(async () => {
  try {
    const sqliteHelpers = await import("@/lib/sqliteHelpers.js");
    sqliteHelpers.closeSqliteDb();
  } catch (_) {}

  delete process.env.DATA_DIR;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.resetModules();
  cloudWorkerClientMocks.registerWithWorker.mockClear();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("localDb R2 settings", () => {
  it("returns normalized default r2Config from getSettings", async () => {
    const localDb = await loadLocalDb();

    await expect(localDb.getSettings()).resolves.toMatchObject({
      r2Config: {
        accountId: "",
        accessKeyId: "",
        secretAccessKey: "",
        bucket: "",
        endpoint: "",
        region: "",
        publicUrl: "",
        connected: false,
        lastCheckedAt: null,
        lastError: "",
      },
    });
  });

  it("PATCH re-registers existing workers when runtime metadata changes", async () => {
    await loadLocalDb({
      settings: {
        r2RuntimePublicBaseUrl: "https://old-runtime.example.com/base",
        r2RuntimeCacheTtlSeconds: 15,
        cloudSharedSecret: "worker-secret-123456",
        cloudUrls: [
          {
            id: "worker-1",
            url: "https://worker.example.com",
          },
        ],
      },
    });

    const route = await import("../../../src/app/api/r2/route.js");
    const response = await route.PATCH({
      json: async () => ({
        r2RuntimePublicBaseUrl: "https://new-runtime.example.com/base",
        r2RuntimeCacheTtlSeconds: 45,
      }),
    });

    expect(response.status).toBe(200);
    expect(cloudWorkerClientMocks.registerWithWorker).toHaveBeenCalledWith(
      "https://worker.example.com",
      "worker-secret-123456",
      expect.objectContaining({
        runtimeUrl: "https://new-runtime.example.com/base",
        cacheTtlSeconds: 45,
      })
    );
  });

  it("PATCH rejects clearing runtime URL while workers are registered", async () => {
    await loadLocalDb({
      settings: {
        r2RuntimePublicBaseUrl: "https://runtime.example.com/base",
        cloudSharedSecret: "worker-secret-123456",
        cloudUrls: [
          {
            id: "worker-1",
            url: "https://worker.example.com",
          },
        ],
      },
    });

    const route = await import("../../../src/app/api/r2/route.js");
    const response = await route.PATCH({
      json: async () => ({
        r2RuntimePublicBaseUrl: "",
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.r2RuntimePublicBaseUrl).toBe("");
    expect(cloudWorkerClientMocks.registerWithWorker).toHaveBeenCalledTimes(1);
  });

  it("PATCH reports worker registration failures without failing the settings save", async () => {
    cloudWorkerClientMocks.registerWithWorker.mockRejectedValueOnce(new Error("worker offline"));
    const localDb = await loadLocalDb({
      settings: {
        r2RuntimePublicBaseUrl: "https://old-runtime.example.com/base",
        cloudSharedSecret: "worker-secret-123456",
        cloudUrls: [
          {
            id: "worker-1",
            url: "https://worker.example.com",
          },
        ],
      },
    });

    const route = await import("../../../src/app/api/r2/route.js");
    const response = await route.PATCH({
      json: async () => ({
        r2RuntimePublicBaseUrl: "https://new-runtime.example.com/base",
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.workerRegistrationFailures).toEqual([
      {
        url: "https://worker.example.com",
        error: "worker offline",
      },
    ]);
    await expect(localDb.getSettings()).resolves.toMatchObject({
      r2RuntimePublicBaseUrl: "https://new-runtime.example.com/base",
    });
  });

  it("normalizes persisted partial r2Config with defaults", async () => {
    const localDb = await loadLocalDb({
      settings: {
        r2Config: {
          bucket: "media",
          connected: true,
        },
      },
    });

    await expect(localDb.getSettings()).resolves.toMatchObject({
      r2Config: {
        accountId: "",
        accessKeyId: "",
        secretAccessKey: "",
        bucket: "media",
        endpoint: "",
        region: "",
        publicUrl: "",
        connected: true,
        lastCheckedAt: null,
        lastError: "",
      },
    });
  });

  it("normalizes persisted runtime publish settings", async () => {
    const localDb = await loadLocalDb({
      settings: {
        r2AutoPublishEnabled: "true",
        r2RuntimePublicBaseUrl: 123,
        r2RuntimeCacheTtlSeconds: 0,
        r2LastRuntimePublishAt: 456,
        r2LastBackupAt: 789,
        r2LastRestoreAt: {},
      },
    });

    await expect(localDb.getSettings()).resolves.toMatchObject({
      r2AutoPublishEnabled: false,
      r2RuntimePublicBaseUrl: "",
      r2RuntimeCacheTtlSeconds: 15,
      r2LastRuntimePublishAt: null,
      r2LastBackupAt: null,
      r2LastRestoreAt: null,
    });
  });
});

describe("/api/r2 route", () => {
  it("GET returns backup metadata and runtime publish fields", async () => {
    await loadLocalDb({
      settings: {
        r2Config: {
          accountId: "acct",
          accessKeyId: "key",
          secretAccessKey: "secret",
          bucket: "media",
          endpoint: "https://example.r2.cloudflarestorage.com",
          region: "auto",
          publicUrl: "https://cdn.example.com",
          connected: true,
          lastCheckedAt: "2026-04-26T12:00:00.000Z",
          lastError: "",
        },
        r2BackupEnabled: true,
        r2SqliteBackupSchedule: "weekly",
        r2AutoPublishEnabled: true,
        r2RuntimePublicBaseUrl: "https://runtime.example.com/base",
        r2RuntimeCacheTtlSeconds: 30,
        r2LastRuntimePublishAt: "2026-04-26T03:15:00.000Z",
        r2LastBackupAt: "2026-04-25T00:00:00.000Z",
        r2LastRestoreAt: "2026-04-24T00:00:00.000Z",
      },
    });

    const route = await import("../../../src/app/api/r2/route.js");
    const response = await route.GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      r2BackupEnabled: true,
      r2SqliteBackupSchedule: "weekly",
      r2AutoPublishEnabled: true,
      r2RuntimePublicBaseUrl: "https://runtime.example.com/base",
      r2RuntimeCacheTtlSeconds: 30,
      r2LastRuntimePublishAt: "2026-04-26T03:15:00.000Z",
      r2LastBackupAt: "2026-04-25T00:00:00.000Z",
      r2LastRestoreAt: "2026-04-24T00:00:00.000Z",
    });
  });

  it("PATCH accepts runtime publish field updates", async () => {
    const localDb = await loadLocalDb({
      settings: {
        r2LastBackupAt: "2026-04-25T00:00:00.000Z",
        r2LastRestoreAt: "2026-04-24T00:00:00.000Z",
      },
    });

    const route = await import("../../../src/app/api/r2/route.js");
    const response = await route.PATCH({
      json: async () => ({
        r2AutoPublishEnabled: true,
        r2RuntimePublicBaseUrl: "  https://runtime.example.com/base  ",
        r2RuntimeCacheTtlSeconds: 45,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      r2BackupEnabled: false,
      r2SqliteBackupSchedule: "daily",
      r2AutoPublishEnabled: true,
      r2RuntimePublicBaseUrl: "https://runtime.example.com/base",
      r2RuntimeCacheTtlSeconds: 45,
      r2LastRuntimePublishAt: null,
      r2LastBackupAt: "2026-04-25T00:00:00.000Z",
      r2LastRestoreAt: "2026-04-24T00:00:00.000Z",
    });

    await expect(localDb.getSettings()).resolves.toMatchObject({
      r2AutoPublishEnabled: true,
      r2RuntimePublicBaseUrl: "https://runtime.example.com/base",
      r2RuntimeCacheTtlSeconds: 45,
      r2LastBackupAt: "2026-04-25T00:00:00.000Z",
      r2LastRestoreAt: "2026-04-24T00:00:00.000Z",
    });
  });

  it("PATCH persists r2Config edits and resets connection validation metadata", async () => {
    const localDb = await loadLocalDb({
      settings: {
        r2Config: {
          accountId: "old-acct",
          accessKeyId: "old-key",
          secretAccessKey: "old-secret",
          bucket: "old-bucket",
          endpoint: "https://old.example.com",
          region: "auto",
          publicUrl: "https://old-cdn.example.com",
          connected: true,
          lastCheckedAt: "2026-04-26T12:00:00.000Z",
          lastError: "",
        },
      },
    });

    const route = await import("../../../src/app/api/r2/route.js");
    const response = await route.PATCH({
      json: async () => ({
        r2Config: {
          accountId: "new-acct",
          accessKeyId: "new-key",
          secretAccessKey: "new-secret",
          bucket: "new-bucket",
          endpoint: "https://new.example.com/",
          region: "auto",
          publicUrl: "https://new-cdn.example.com/",
        },
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.r2Config).toMatchObject({
      accountId: "new-acct",
      accessKeyId: "new-key",
      secretAccessKey: "new-secret",
      bucket: "new-bucket",
      endpoint: "https://new.example.com/",
      region: "auto",
      publicUrl: "https://new-cdn.example.com/",
      connected: false,
      lastCheckedAt: null,
      lastError: "",
    });

    await expect(localDb.getSettings()).resolves.toMatchObject({
      r2Config: payload.r2Config,
    });
  });

  it("PATCH rejects invalid r2Config field types", async () => {
    await loadLocalDb();

    const route = await import("../../../src/app/api/r2/route.js");
    const response = await route.PATCH({
      json: async () => ({
        r2Config: {
          accountId: "acct",
          accessKeyId: "key",
          secretAccessKey: "secret",
          bucket: "bucket",
          endpoint: "https://example.com",
          region: 123,
        },
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: "Invalid r2Config.region. Expected a string.",
    });
  });

  it("GET falls back to 15 when persisted runtime cache ttl is invalid", async () => {
    await loadLocalDb({
      settings: {
        r2RuntimeCacheTtlSeconds: 999,
        r2LastBackupAt: 123,
        r2LastRestoreAt: false,
      },
    });

    const route = await import("../../../src/app/api/r2/route.js");
    const response = await route.GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.r2RuntimeCacheTtlSeconds).toBe(15);
    expect(payload.r2LastBackupAt).toBeNull();
    expect(payload.r2LastRestoreAt).toBeNull();
  });

  it("PATCH rejects invalid backup schedules", async () => {
    await loadLocalDb();

    const route = await import("../../../src/app/api/r2/route.js");
    const response = await route.PATCH({
      json: async () => ({
        r2SqliteBackupSchedule: "hourly",
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: "Invalid R2 backup schedule. Expected one of: daily, weekly, monthly.",
    });
  });

  it("PATCH rejects invalid runtime cache ttl values", async () => {
    await loadLocalDb();

    const route = await import("../../../src/app/api/r2/route.js");
    const response = await route.PATCH({
      json: async () => ({
        r2RuntimeCacheTtlSeconds: 0,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: "Invalid r2RuntimeCacheTtlSeconds. Expected an integer between 1 and 300.",
    });
  });

  it("PATCH rejects invalid runtime publish field types", async () => {
    await loadLocalDb();

    const route = await import("../../../src/app/api/r2/route.js");
    const response = await route.PATCH({
      json: async () => ({
        r2AutoPublishEnabled: "yes",
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: "Invalid r2AutoPublishEnabled. Expected a boolean.",
    });
  });
});

describe("Task 6 direct R2 routes", () => {
  it("POST /api/r2/backup returns artifact-based direct publish summary", async () => {
    await loadLocalDb({
      settings: {
        r2RuntimePublicBaseUrl: "https://storage.example.com/runtime",
      },
    });

    vi.doMock("@/lib/r2BackupClient", () => ({
      publishRuntimeArtifactsFromSettings: vi.fn().mockResolvedValue({
        backup: { ok: true, uploaded: true, skipped: false, attempts: 1 },
        runtime: { ok: true, uploaded: true, skipped: false, attempts: 1 },
        sqlite: { ok: true, uploaded: false, skipped: true, attempts: 0 },
        sqliteFingerprint: "fp-1",
        sqliteChanged: false,
      }),
    }));

    const route = await import("../../../src/app/api/r2/backup/route.js");
    const response = await route.POST();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      backup: { uploaded: true },
      runtime: { uploaded: true },
      sqlite: { skipped: true, uploaded: false },
      sqliteChanged: false,
    });
    expect(payload).not.toHaveProperty("successes");
    expect(payload).not.toHaveProperty("total");
  });

  it("GET /api/r2/info reports direct publish status instead of worker reachability", async () => {
    await loadLocalDb({
      settings: {
        r2BackupEnabled: true,
        r2RuntimePublicBaseUrl: "https://storage.example.com/runtime/",
        r2LastRuntimePublishAt: "2026-04-27T01:00:00.000Z",
        r2LastBackupAt: "2026-04-27T02:00:00.000Z",
        r2LastRestoreAt: "2026-04-27T03:00:00.000Z",
      },
    });

    vi.doMock("@/lib/r2BackupClient", () => ({
      readBackupArtifactFromSettings: vi.fn().mockResolvedValue({
        artifactUrl: "https://storage.example.com/runtime/backup.json",
        artifact: {
          generatedAt: "2026-04-27T02:00:00.000Z",
          providers: [{ accessToken: "provider-token" }],
          settings: { r2Config: { secretAccessKey: "r2-secret" } },
          sqlite: {
            key: "sqlite/latest.db",
            url: "https://storage.example.com/runtime/sqlite/latest.db",
          },
        },
      }),
    }));

    const route = await import("../../../src/app/api/r2/info/route.js");
    const response = await route.GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      configured: true,
      runtimeConfigured: true,
      backupConfigured: false,
      backupReady: false,
      restoreReady: false,
      r2BackupEnabled: true,
      r2LastRuntimePublishAt: "2026-04-27T01:00:00.000Z",
      r2LastBackupAt: "2026-04-27T02:00:00.000Z",
      r2LastRestoreAt: "2026-04-27T03:00:00.000Z",
      status: {
        state: "runtime-only",
        summary: expect.stringContaining("Runtime publishing is configured"),
      },
      backupArtifactUrl: null,
      backupArtifact: null,
      artifactError: null,
    });
    expect(JSON.stringify(payload)).not.toContain("provider-token");
    expect(JSON.stringify(payload)).not.toContain("r2-secret");
    expect(payload).not.toHaveProperty("workers");
  });

  it("GET /api/r2/info falls back to local direct status when backup artifact fetch fails", async () => {
    await loadLocalDb({
      settings: {
        r2BackupEnabled: true,
        r2RuntimePublicBaseUrl: "https://storage.example.com/runtime/",
        r2LastRuntimePublishAt: "2026-04-27T01:00:00.000Z",
        r2LastBackupAt: "2026-04-27T02:00:00.000Z",
      },
    });

    vi.doMock("@/lib/r2BackupClient", () => ({
      readBackupArtifactFromSettings: vi.fn().mockRejectedValue(new Error("backup.json missing")),
    }));

    const route = await import("../../../src/app/api/r2/info/route.js");
    const response = await route.GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      configured: true,
      runtimeConfigured: true,
      backupConfigured: false,
      backupReady: false,
      restoreReady: false,
      r2BackupEnabled: true,
      r2LastRuntimePublishAt: "2026-04-27T01:00:00.000Z",
      r2LastBackupAt: "2026-04-27T02:00:00.000Z",
      status: {
        state: "runtime-only",
        summary: expect.stringContaining("Runtime publishing is configured"),
      },
      backupArtifactUrl: null,
      backupArtifact: null,
      artifactError: null,
    });
  });

  it("GET /api/r2/info reports backup status with private R2 config and no runtime URL", async () => {
    await loadLocalDb({
      settings: {
        r2BackupEnabled: true,
        r2RuntimePublicBaseUrl: "",
        r2LastBackupAt: "2026-04-27T02:00:00.000Z",
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "secret",
          region: "auto",
        },
      },
    });

    vi.doMock("@/lib/r2BackupClient", () => ({
      readBackupArtifactFromSettings: vi.fn().mockResolvedValue({
        artifactUrl: "https://acct.r2.cloudflarestorage.com/media/private/backups/backup.json",
        artifact: {
          generatedAt: "2026-04-27T02:00:00.000Z",
          sqlite: { key: "private/backups/sqlite/latest.db", size: 1234 },
        },
      }),
    }));

    const route = await import("../../../src/app/api/r2/info/route.js");
    const response = await route.GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      configured: true,
      backupArtifactUrl: "https://acct.r2.cloudflarestorage.com/media/private/backups/backup.json",
      backupArtifact: {
        generatedAt: "2026-04-27T02:00:00.000Z",
        sqlite: { key: "private/backups/sqlite/latest.db", size: 1234 },
      },
      status: {
        state: "ready",
        summary: expect.stringContaining("Direct R2 configured"),
      },
    });
  });

  it("GET /api/r2/restore lists direct artifact restore info", async () => {
    await loadLocalDb({
      settings: {
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "secret",
          region: "auto",
        },
      },
    });

    vi.doMock("@/lib/r2BackupClient", () => ({
      readBackupArtifactFromSettings: vi.fn().mockResolvedValue({
        artifactUrl: "https://storage.example.com/runtime/backup.json",
        artifact: {
          generatedAt: "2026-04-27T05:00:00.000Z",
          machineId: "machine-123",
          sqlite: {
            key: "sqlite/latest.db",
            url: "https://storage.example.com/runtime/sqlite/latest.db",
            size: 4321,
          },
        },
      }),
    }));

    const route = await import("../../../src/app/api/r2/restore/route.js");
    const response = await route.GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      backups: [
        {
          key: "sqlite/latest.db",
          url: "https://storage.example.com/runtime/sqlite/latest.db",
          generatedAt: "2026-04-27T05:00:00.000Z",
          machineId: "machine-123",
          size: 4321,
        },
      ],
      backupArtifactUrl: "https://storage.example.com/runtime/backup.json",
    });
    expect(payload).not.toHaveProperty("workerUrl");
    expect(payload).not.toHaveProperty("workerName");
  });

  it("POST /api/r2/restore restores from direct artifact metadata and persists last restore time", async () => {
    const localDb = await loadLocalDb({
      settings: {
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "secret",
          region: "auto",
        },
      },
    });

    vi.doMock("@/lib/r2BackupClient", () => ({
      readBackupArtifactFromSettings: vi.fn().mockResolvedValue({
        artifactUrl: "https://storage.example.com/runtime/backup.json",
        artifact: {
          generatedAt: "2026-04-27T05:00:00.000Z",
          machineId: "machine-123",
          sqlite: {
            key: "sqlite/latest.db",
            url: "https://storage.example.com/runtime/sqlite/latest.db",
            size: 4321,
          },
        },
      }),
      restoreFromDirectBackupSettings: vi.fn().mockResolvedValue({
        success: true,
        restoredBackup: "sqlite/latest.db",
        backupSize: 1234,
        restoredAt: "2026-04-27T06:00:00.000Z",
      }),
    }));

    const route = await import("../../../src/app/api/r2/restore/route.js");
    const response = await route.POST({
      json: async () => ({ confirmRestore: true }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      restoredBackup: {
        key: "sqlite/latest.db",
      },
    });
    await expect(localDb.getSettings()).resolves.toMatchObject({
      r2LastRestoreAt: expect.any(String),
    });
  });

  it("POST /api/r2/restore does not update last restore time when restore returns success false", async () => {
    const localDb = await loadLocalDb({
      settings: {
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "secret",
          region: "auto",
        },
        r2LastRestoreAt: "2026-04-26T00:00:00.000Z",
      },
    });

    vi.doMock("@/lib/r2BackupClient", () => ({
      readBackupArtifactFromSettings: vi.fn().mockResolvedValue({
        artifactUrl: "https://storage.example.com/runtime/backup.json",
        artifact: {
          generatedAt: "2026-04-27T05:00:00.000Z",
          machineId: "machine-123",
          sqlite: {
            key: "sqlite/latest.db",
            url: "https://storage.example.com/runtime/sqlite/latest.db",
            size: 4321,
          },
        },
      }),
      restoreFromDirectBackupSettings: vi.fn().mockResolvedValue({
        success: false,
        error: "restore rejected",
      }),
    }));

    const route = await import("../../../src/app/api/r2/restore/route.js");
    const response = await route.POST({
      json: async () => ({ confirmRestore: true }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: false,
      error: "restore rejected",
    });
    await expect(localDb.getSettings()).resolves.toMatchObject({
      r2LastRestoreAt: "2026-04-26T00:00:00.000Z",
    });
  });

  it("POST /api/r2/restore does not update last restore time when restore throws", async () => {
    const localDb = await loadLocalDb({
      settings: {
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "secret",
          region: "auto",
        },
        r2LastRestoreAt: "2026-04-26T00:00:00.000Z",
      },
    });

    vi.doMock("@/lib/r2BackupClient", () => ({
      readBackupArtifactFromSettings: vi.fn().mockResolvedValue({
        artifactUrl: "https://storage.example.com/runtime/backup.json",
        artifact: {
          generatedAt: "2026-04-27T05:00:00.000Z",
          machineId: "machine-123",
          sqlite: {
            key: "sqlite/latest.db",
            url: "https://storage.example.com/runtime/sqlite/latest.db",
            size: 4321,
          },
        },
      }),
      restoreFromDirectBackupSettings: vi.fn().mockRejectedValue(new Error("restore exploded")),
    }));

    const route = await import("../../../src/app/api/r2/restore/route.js");
    const response = await route.POST({
      json: async () => ({ confirmRestore: true }),
    });
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      error: "restore exploded",
    });
    await expect(localDb.getSettings()).resolves.toMatchObject({
      r2LastRestoreAt: "2026-04-26T00:00:00.000Z",
    });
  });
});
