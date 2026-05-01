import { describe, expect, it, vi } from "vitest";

describe("putObjectWithRetry", () => {
  it("retries failed PUT responses and returns attempts after a later success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Server Error" })
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "Busy" })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const { putObjectWithRetry } = await import("@/lib/r2ObjectClient.js");

    await expect(
      putObjectWithRetry({
        objectUrl: "https://r2.example.com/runtime.json",
        body: '{"ok":true}',
        contentType: "application/json",
        fetchImpl,
        sleep,
      })
    ).resolves.toEqual({ ok: true, attempts: 3 });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://r2.example.com/runtime.json",
      expect.objectContaining({
        method: "PUT",
        body: '{"ok":true}',
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it("throws a useful error after the final failed response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const { putObjectWithRetry } = await import("@/lib/r2ObjectClient.js");

    await expect(
      putObjectWithRetry({
        objectUrl: "https://r2.example.com/backup.json",
        body: "payload",
        contentType: "application/octet-stream",
        maxAttempts: 3,
        fetchImpl,
        sleep,
      })
    ).rejects.toThrow(
      "Failed to PUT R2 object https://r2.example.com/backup.json after 3 attempts: 403 Forbidden"
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it("signs R2 S3 PUT requests when R2 config is provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const { putObjectWithRetry } = await import("@/lib/r2ObjectClient.js");

    await putObjectWithRetry({
      objectUrl: "https://acct.r2.cloudflarestorage.com/media/runtime.json",
      body: '{"ok":true}',
      contentType: "application/json",
      r2Config: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        region: "auto",
      },
      now: () => new Date("2026-04-27T01:02:03.000Z"),
      fetchImpl,
      sleep,
    });

    const [, request] = fetchImpl.mock.calls[0];
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-amz-date": "20260427T010203Z",
    });
    expect(request.headers.Authorization).toContain("AWS4-HMAC-SHA256 Credential=test-access-key/20260427/auto/s3/aws4_request");
    expect(request.headers.Authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    expect(request.headers).not.toHaveProperty("X-Auth-Key");
    expect(request.headers).not.toHaveProperty("X-Auth-Secret");
  });
});

describe("publishRuntimeArtifacts", () => {
  it("uploads backup and runtime, and skips sqlite when unchanged", async () => {
    const uploaded = [];
    const putObject = vi.fn().mockImplementation(async ({ objectUrl }) => {
      uploaded.push(objectUrl);
      return { ok: true, attempts: 1 };
    });

    const { publishRuntimeArtifacts } = await import("@/lib/r2BackupClient.js");

    await expect(
      publishRuntimeArtifacts({
        artifactUrls: {
          backupUrl: "https://storage.example.com/backup.json",
          runtimeUrl: "https://storage.example.com/runtime.json",
          eligibleUrl: "https://storage.example.com/eligible.json",
          sqliteUrl: "https://storage.example.com/sqlite/latest.db",
        },
        dbSnapshot: {
          format: "9router-db-v1",
          schemaVersion: 1,
          providerConnections: [
            { id: "conn-1", provider: "anthropic", isActive: true, routingStatus: "eligible" },
          ],
          modelAliases: {},
          combos: [],
          apiKeys: [],
          settings: {},
        },
        sqliteChanged: false,
        putObject,
      })
    ).resolves.toMatchObject({
      backup: { uploaded: true, attempts: 1 },
      runtime: { uploaded: true, attempts: 1 },
      eligible: { uploaded: true, attempts: 1 },
      sqlite: { skipped: true, uploaded: false },
    });

    expect(uploaded).toEqual([
      "https://storage.example.com/backup.json",
      "https://storage.example.com/runtime.json",
      "https://storage.example.com/eligible.json",
    ]);
  });

  it("uploads sqlite when the database changed", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 2 });

    const { publishRuntimeArtifacts } = await import("@/lib/r2BackupClient.js");

    const result = await publishRuntimeArtifacts({
      artifactUrls: {
        backupUrl: "https://storage.example.com/backup.json",
        runtimeUrl: "https://storage.example.com/runtime.json",
        eligibleUrl: "https://storage.example.com/eligible.json",
        sqliteUrl: "https://storage.example.com/sqlite/latest.db",
      },
      dbSnapshot: {
        format: "9router-db-v1",
        schemaVersion: 1,
        providerConnections: [],
        modelAliases: {},
        combos: [],
        apiKeys: [],
        settings: {},
      },
      sqliteChanged: true,
      sqliteData: Buffer.from("sqlite-bytes"),
      putObject,
    });

    expect(putObject).toHaveBeenCalledTimes(4);
    expect(putObject).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        objectUrl: "https://storage.example.com/sqlite/latest.db",
        body: Buffer.from("sqlite-bytes"),
        contentType: "application/octet-stream",
      })
    );
    expect(result.sqlite).toMatchObject({ uploaded: true, skipped: false, attempts: 2 });
  });

  it("preserves artifact-level failures when sqlite upload fails after config publishes succeed", async () => {
    const putObject = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, attempts: 1 })
      .mockResolvedValueOnce({ ok: true, attempts: 1 })
      .mockResolvedValueOnce({ ok: true, attempts: 1 })
      .mockRejectedValueOnce(new Error("sqlite upload failed"));

    const { publishRuntimeArtifacts } = await import("@/lib/r2BackupClient.js");

    const result = await publishRuntimeArtifacts({
      artifactUrls: {
        backupUrl: "https://storage.example.com/backup.json",
        runtimeUrl: "https://storage.example.com/runtime.json",
        eligibleUrl: "https://storage.example.com/eligible.json",
        sqliteUrl: "https://storage.example.com/sqlite/latest.db",
      },
      dbSnapshot: {
        format: "9router-db-v1",
        schemaVersion: 1,
        providerConnections: [],
        modelAliases: {},
        combos: [],
        apiKeys: [],
        settings: {},
      },
      sqliteChanged: true,
      sqliteData: Buffer.from("sqlite-bytes"),
      putObject,
    });

    expect(result.backup).toMatchObject({ uploaded: true, ok: true });
    expect(result.runtime).toMatchObject({ uploaded: true, ok: true });
    expect(result.eligible).toMatchObject({ uploaded: true, ok: true });
    expect(result.sqlite).toMatchObject({ uploaded: false, skipped: false, error: "sqlite upload failed" });
  });

  it("uses the injected retry helper dependency for all uploads", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 3 });

    const { publishRuntimeArtifacts } = await import("@/lib/r2BackupClient.js");

    await publishRuntimeArtifacts({
      artifactUrls: {
        backupUrl: "https://storage.example.com/backup.json",
        runtimeUrl: "https://storage.example.com/runtime.json",
        eligibleUrl: "https://storage.example.com/eligible.json",
        sqliteUrl: "https://storage.example.com/sqlite/latest.db",
      },
      dbSnapshot: {
        format: "9router-db-v1",
        schemaVersion: 1,
        providerConnections: [],
        modelAliases: {},
        combos: [],
        apiKeys: [],
        settings: {},
      },
      sqliteChanged: true,
      sqliteData: Buffer.from("sqlite-bytes"),
      putObject,
    });

    expect(putObject).toHaveBeenCalledTimes(4);
    expect(putObject).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ objectUrl: "https://storage.example.com/backup.json" })
    );
    expect(putObject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ objectUrl: "https://storage.example.com/runtime.json" })
    );
    expect(putObject).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ objectUrl: "https://storage.example.com/eligible.json" })
    );
    expect(putObject).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ objectUrl: "https://storage.example.com/sqlite/latest.db" })
    );
  });

  it("derives eligible.json when only runtimeUrl is provided", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });

    const { publishRuntimeArtifacts } = await import("@/lib/r2BackupClient.js");

    await publishRuntimeArtifacts({
      artifactUrls: {
        backupUrl: "https://storage.example.com/backup.json",
        runtimeUrl: "https://storage.example.com/runtime.json",
        sqliteUrl: "https://storage.example.com/sqlite/latest.db",
      },
      dbSnapshot: {
        format: "9router-db-v1",
        schemaVersion: 1,
        providerConnections: [],
        modelAliases: {},
        combos: [],
        apiKeys: [],
        settings: {},
      },
      sqliteChanged: false,
      putObject,
    });

    expect(putObject).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ objectUrl: "https://storage.example.com/eligible.json" })
    );
  });
});

describe("publishRuntimeArtifactsFromSettings", () => {
  function buildSettings(overrides = {}) {
    return {
      r2RuntimePublicBaseUrl: "https://storage.example.com/runtime",
      r2BackupPrefix: "private/backups",
      r2LastSqliteBackupFingerprint: "fp-1",
      ...overrides,
    };
  }

  function buildSnapshot() {
    return {
      format: "9router-db-v1",
      schemaVersion: 1,
      providerConnections: [],
      modelAliases: {},
      combos: [],
      apiKeys: [],
      settings: {},
    };
  }

  it("uploads config artifacts, skips unchanged sqlite, and patches runtime publish only when both config uploads succeed", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });
    const settingsUpdater = vi.fn().mockResolvedValue(undefined);

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    const result = await publishRuntimeArtifactsFromSettings({
      settings: buildSettings(),
      dbSnapshot: buildSnapshot(),
      putObject,
      settingsUpdater,
      fingerprintReader: vi.fn().mockReturnValue({
        fingerprint: "fp-1",
        data: Buffer.from("sqlite-bytes"),
      }),
    });

    expect(putObject).toHaveBeenCalledTimes(3);
    expect(result.sqlite).toMatchObject({ ok: true, uploaded: false, skipped: true });
    expect(settingsUpdater).toHaveBeenCalledTimes(1);
    expect(settingsUpdater).toHaveBeenCalledWith({
      r2LastRuntimePublishAt: expect.any(String),
    });
  });

  it("writes backup and sqlite artifacts outside the public runtime prefix when R2 config is present", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    await publishRuntimeArtifactsFromSettings({
      settings: buildSettings({
        r2RuntimePublicBaseUrl: "https://public.example.com/runtime",
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "secret",
          region: "auto",
        },
      }),
      dbSnapshot: buildSnapshot(),
      putObject,
      settingsUpdater: vi.fn().mockResolvedValue(undefined),
      fingerprintReader: vi.fn().mockReturnValue({
        fingerprint: "fp-1",
        data: Buffer.from("sqlite-bytes"),
      }),
    });

    expect(putObject).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        objectUrl: "https://acct.r2.cloudflarestorage.com/media/private/backups/backup.json",
      })
    );
    expect(putObject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        objectUrl: "https://acct.r2.cloudflarestorage.com/media/runtime/runtime.json",
      })
    );
    expect(putObject).not.toHaveBeenCalledWith(
      expect.objectContaining({ objectUrl: expect.stringContaining("public.example.com") })
    );
  });

  it("writes runtime.json under the public runtime URL path", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    await publishRuntimeArtifactsFromSettings({
      settings: buildSettings({
        r2RuntimePublicBaseUrl: "https://public.example.com/runtime/v1",
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "secret",
          region: "auto",
        },
      }),
      dbSnapshot: buildSnapshot(),
      putObject,
      settingsUpdater: vi.fn().mockResolvedValue(undefined),
      fingerprintReader: vi.fn().mockReturnValue({
        fingerprint: "fp-1",
        data: Buffer.from("sqlite-bytes"),
      }),
    });

    expect(putObject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        objectUrl: "https://acct.r2.cloudflarestorage.com/media/runtime/v1/runtime.json",
      })
    );
  });

  it("rejects public-root runtime URLs when private backups share the same bucket", async () => {
    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    await expect(
      publishRuntimeArtifactsFromSettings({
        settings: buildSettings({
          r2RuntimePublicBaseUrl: "https://public.example.com",
          r2Config: {
            endpoint: "https://acct.r2.cloudflarestorage.com",
            bucket: "media",
            accessKeyId: "key",
            secretAccessKey: "secret",
            region: "auto",
          },
        }),
        dbSnapshot: buildSnapshot(),
        putObject: vi.fn(),
        settingsUpdater: vi.fn(),
        fingerprintReader: vi.fn().mockReturnValue({ fingerprint: "fp-1", data: Buffer.from("sqlite") }),
      })
    ).rejects.toThrow("Runtime public base URL must include a path prefix");
  });

  it("updates backup timestamp and fingerprint when changed sqlite upload succeeds", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 2 });
    const settingsUpdater = vi.fn().mockResolvedValue(undefined);

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    const result = await publishRuntimeArtifactsFromSettings({
      settings: buildSettings({ r2LastSqliteBackupFingerprint: "old-fp" }),
      dbSnapshot: buildSnapshot(),
      putObject,
      settingsUpdater,
      fingerprintReader: vi.fn().mockReturnValue({
        fingerprint: "new-fp",
        data: Buffer.from("sqlite-bytes"),
      }),
    });

    expect(result.sqlite).toMatchObject({ ok: true, uploaded: true, skipped: false, attempts: 2 });
    expect(settingsUpdater).toHaveBeenCalledTimes(1);
    expect(settingsUpdater).toHaveBeenCalledWith({
      r2LastRuntimePublishAt: expect.any(String),
      r2LastBackupAt: expect.any(String),
      r2LastSqliteBackupFingerprint: "new-fp",
    });
  });

  it("publishes encrypted backup and sqlite envelopes with safe restore metadata", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });
    const secretSnapshot = {
      format: "9router-db-v1",
      schemaVersion: 1,
      providerConnections: [
        { id: "conn-secret", provider: "anthropic", accessToken: "provider-token-secret", isActive: true, routingStatus: "eligible" },
      ],
      modelAliases: {},
      combos: [],
      apiKeys: [{ id: "key-secret", key: "client-api-secret", isActive: true }],
      settings: {
        r2Config: { secretAccessKey: "r2-secret" },
        cloudUrls: [{ secret: "worker-secret" }],
      },
    };

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    await publishRuntimeArtifactsFromSettings({
      settings: buildSettings({
        r2RuntimePublicBaseUrl: "https://public.example.com/runtime",
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "backup-encryption-secret",
          region: "auto",
        },
      }),
      dbSnapshot: secretSnapshot,
      putObject,
      settingsUpdater: vi.fn().mockResolvedValue(undefined),
      fingerprintReader: vi.fn().mockReturnValue({
        fingerprint: "new-fp",
        data: Buffer.from("sqlite-bytes-secret"),
      }),
    });

    const backupBody = String(putObject.mock.calls[0][0].body);
    const backupArtifact = JSON.parse(backupBody);
    expect(backupArtifact).toMatchObject({
      format: "9router-r2-encrypted-backup-v1",
      encrypted: true,
      sqlite: {
        key: "private/backups/sqlite/latest.db",
        encrypted: true,
        size: Buffer.byteLength("sqlite-bytes-secret"),
      },
      payload: {
        alg: "aes-256-gcm",
        data: expect.any(String),
      },
    });
    expect(backupBody).not.toContain("provider-token-secret");
    expect(backupBody).not.toContain("client-api-secret");
    expect(backupBody).not.toContain("r2-secret");
    expect(backupBody).not.toContain("worker-secret");

    const sqliteBody = Buffer.isBuffer(putObject.mock.calls[3][0].body)
      ? putObject.mock.calls[3][0].body.toString("utf8")
      : String(putObject.mock.calls[3][0].body);
    const sqliteEnvelope = JSON.parse(sqliteBody);
    expect(sqliteEnvelope).toMatchObject({
      format: "9router-r2-encrypted-sqlite-v1",
      encrypted: true,
      payload: {
        alg: "aes-256-gcm",
        data: expect.any(String),
      },
    });
    expect(sqliteBody).not.toContain("sqlite-bytes-secret");
  });

  it("uses a stable backup encryption key instead of mutable R2 credentials", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });
    const settingsUpdater = vi.fn().mockResolvedValue(undefined);

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    await publishRuntimeArtifactsFromSettings({
      settings: buildSettings({
        r2BackupEncryptionKey: "stable-backup-key-material",
        r2RuntimePublicBaseUrl: "https://public.example.com/runtime",
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "*****************",
          region: "auto",
        },
      }),
      dbSnapshot: buildSnapshot(),
      putObject,
      settingsUpdater,
      fingerprintReader: vi.fn().mockReturnValue({
        fingerprint: "new-fp",
        data: Buffer.from("sqlite-bytes"),
      }),
    });

    const backupArtifact = JSON.parse(String(putObject.mock.calls[0][0].body));
    const sqliteEnvelope = JSON.parse(Buffer.from(putObject.mock.calls[3][0].body).toString("utf8"));
    expect(backupArtifact.payload.keyId).toBe("local-r2-backup-key-v1");
    expect(sqliteEnvelope.payload.keyId).toBe("local-r2-backup-key-v1");
    expect(JSON.stringify(backupArtifact)).not.toContain("old-r2-secret");
    expect(settingsUpdater).toHaveBeenCalledWith(expect.not.objectContaining({
      r2BackupEncryptionKey: expect.any(String),
    }));
  });

  it("generates and persists a stable backup encryption key when missing", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });
    const settingsUpdater = vi.fn().mockResolvedValue(undefined);

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    await publishRuntimeArtifactsFromSettings({
      settings: buildSettings({
        r2BackupEncryptionKey: null,
        r2RuntimePublicBaseUrl: "https://public.example.com/runtime",
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "current-r2-secret",
          region: "auto",
        },
      }),
      dbSnapshot: buildSnapshot(),
      putObject,
      settingsUpdater,
      fingerprintReader: vi.fn().mockReturnValue({
        fingerprint: "new-fp",
        data: Buffer.from("sqlite-bytes"),
      }),
    });

    expect(settingsUpdater).toHaveBeenCalledWith(expect.objectContaining({
      r2BackupEncryptionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    const backupArtifact = JSON.parse(String(putObject.mock.calls[0][0].body));
    expect(backupArtifact.payload.keyId).toBe("local-r2-backup-key-v1");
  });

  it("does not upload encrypted artifacts if generated key persistence fails", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });
    const settingsUpdater = vi.fn().mockRejectedValue(new Error("settings write failed"));

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    await expect(publishRuntimeArtifactsFromSettings({
      settings: buildSettings({
        r2BackupEncryptionKey: null,
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "current-r2-secret",
          region: "auto",
        },
      }),
      dbSnapshot: buildSnapshot(),
      putObject,
      settingsUpdater,
      fingerprintReader: vi.fn().mockReturnValue({
        fingerprint: "new-fp",
        data: Buffer.from("sqlite-bytes"),
      }),
    })).rejects.toThrow("settings write failed");

    expect(settingsUpdater).toHaveBeenCalledWith({
      r2BackupEncryptionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(putObject).not.toHaveBeenCalled();
  });

  it("reuses the persisted backup encryption key when a concurrent writer stores one first", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });
    const persistedKey = "b".repeat(64);
    const settingsUpdater = vi.fn()
      .mockImplementationOnce(async (patch) => {
        expect(patch.r2BackupEncryptionKey).toMatch(/^[a-f0-9]{64}$/);
        return {
          ...buildSettings({
            r2BackupEncryptionKey: persistedKey,
            r2Config: {
              endpoint: "https://acct.r2.cloudflarestorage.com",
              bucket: "media",
              accessKeyId: "key",
              secretAccessKey: "current-r2-secret",
              region: "auto",
            },
          }),
        };
      })
      .mockResolvedValue(undefined);

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    await publishRuntimeArtifactsFromSettings({
      settings: buildSettings({
        r2BackupEncryptionKey: null,
        r2Config: {
          endpoint: "https://acct.r2.cloudflarestorage.com",
          bucket: "media",
          accessKeyId: "key",
          secretAccessKey: "current-r2-secret",
          region: "auto",
        },
      }),
      dbSnapshot: buildSnapshot(),
      putObject,
      settingsUpdater,
      fingerprintReader: vi.fn().mockReturnValue({
        fingerprint: "new-fp",
        data: Buffer.from("sqlite-bytes"),
      }),
    });

    const backupArtifact = JSON.parse(String(putObject.mock.calls[0][0].body));
    expect(backupArtifact.payload.keyId).toBe("local-r2-backup-key-v1");
    expect(settingsUpdater).toHaveBeenCalledTimes(2);
  });

  it("re-reads settings when key persistence does not return updated settings", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });
    const persistedKey = "c".repeat(64);
    const settingsUpdater = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(undefined);
    const initialSettings = buildSettings({
      r2BackupEncryptionKey: null,
      r2Config: {
        endpoint: "https://acct.r2.cloudflarestorage.com",
        bucket: "media",
        accessKeyId: "key",
        secretAccessKey: "current-r2-secret",
        region: "auto",
      },
    });
    const settingsReader = vi.fn()
      .mockResolvedValueOnce(initialSettings)
      .mockResolvedValueOnce(
        buildSettings({
          r2BackupEncryptionKey: persistedKey,
          r2Config: {
            endpoint: "https://acct.r2.cloudflarestorage.com",
            bucket: "media",
            accessKeyId: "key",
            secretAccessKey: "current-r2-secret",
            region: "auto",
          },
        })
      );

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    await publishRuntimeArtifactsFromSettings({
      settings: null,
      dbSnapshot: buildSnapshot(),
      putObject,
      settingsUpdater,
      settingsReader,
      fingerprintReader: vi.fn().mockReturnValue({
        fingerprint: "new-fp",
        data: Buffer.from("sqlite-bytes"),
      }),
    });

    expect(settingsReader).toHaveBeenCalledTimes(2);
    const backupArtifact = JSON.parse(String(putObject.mock.calls[0][0].body));
    expect(backupArtifact.payload.keyId).toBe("local-r2-backup-key-v1");
  });

  it("keeps backup and runtime publishing independent when fingerprint reading fails", async () => {
    const putObject = vi.fn().mockResolvedValue({ ok: true, attempts: 1 });
    const settingsUpdater = vi.fn().mockResolvedValue(undefined);

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    const result = await publishRuntimeArtifactsFromSettings({
      settings: buildSettings(),
      dbSnapshot: buildSnapshot(),
      putObject,
      settingsUpdater,
      fingerprintReader: vi.fn().mockImplementation(() => {
        throw new Error("sqlite unreadable");
      }),
    });

    expect(putObject).toHaveBeenCalledTimes(3);
    expect(result.backup).toMatchObject({ ok: true, uploaded: true });
    expect(result.runtime).toMatchObject({ ok: true, uploaded: true });
    expect(result.sqlite).toEqual({
      ok: false,
      uploaded: false,
      skipped: false,
      attempts: 0,
      error: "sqlite unreadable",
    });
    expect(settingsUpdater).toHaveBeenCalledTimes(1);
    expect(settingsUpdater).toHaveBeenCalledWith({
      r2LastRuntimePublishAt: expect.any(String),
    });
  });

  it("does not patch runtime publish time when only one config artifact succeeds", async () => {
    const putObject = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, attempts: 1 })
      .mockRejectedValueOnce(new Error("runtime failed"));
    const settingsUpdater = vi.fn().mockResolvedValue(undefined);

    const { publishRuntimeArtifactsFromSettings } = await import("@/lib/r2BackupClient.js");

    const result = await publishRuntimeArtifactsFromSettings({
      settings: buildSettings(),
      dbSnapshot: buildSnapshot(),
      putObject,
      settingsUpdater,
      fingerprintReader: vi.fn().mockReturnValue({
        fingerprint: "fp-1",
        data: Buffer.from("sqlite-bytes"),
      }),
    });

    expect(result.backup).toMatchObject({ ok: true, uploaded: true });
    expect(result.runtime).toMatchObject({ ok: false, uploaded: false, error: "runtime failed" });
    expect(result.sqlite).toMatchObject({ ok: true, uploaded: false, skipped: true });
    expect(settingsUpdater).not.toHaveBeenCalled();
  });
});

describe("direct artifact reads", () => {
  it("reads backup metadata from the private signed R2 object URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        generatedAt: "2026-04-27T00:00:00.000Z",
        sqlite: {
          key: "sqlite/latest.db",
          url: "https://storage.example.com/runtime/sqlite/latest.db",
        },
      }),
    });

    const { readBackupArtifactFromSettings } = await import("@/lib/r2BackupClient.js");

    await expect(
      readBackupArtifactFromSettings({
        settings: {
          r2BackupPrefix: "private/backups",
          r2Config: {
            endpoint: "https://acct.r2.cloudflarestorage.com",
            bucket: "media",
            accessKeyId: "test-access-key",
            secretAccessKey: "test-secret-key",
            region: "auto",
          },
        },
        fetchImpl,
      })
    ).resolves.toMatchObject({
      artifactUrl: "https://acct.r2.cloudflarestorage.com/media/private/backups/backup.json",
      artifact: {
        generatedAt: "2026-04-27T00:00:00.000Z",
        sqlite: {
          key: "sqlite/latest.db",
          url: "https://storage.example.com/runtime/sqlite/latest.db",
        },
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://acct.r2.cloudflarestorage.com/media/private/backups/backup.json",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: expect.stringContaining("AWS4-HMAC-SHA256 Credential=test-access-key/"),
          "x-amz-date": expect.any(String),
          "x-amz-content-sha256": expect.any(String),
        }),
      })
    );
  });

  it("requires private R2 config before reading backup artifacts", async () => {
    const { readBackupArtifactFromSettings } = await import("@/lib/r2BackupClient.js");

    await expect(
      readBackupArtifactFromSettings({
        settings: {
          r2RuntimePublicBaseUrl: "https://storage.example.com/runtime/",
        },
        fetchImpl: vi.fn(),
      })
    ).rejects.toThrow("Missing R2 configuration for private backup artifact read");
  });

  it("wires direct restore through the local DB drain and reload hooks", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/lib/r2BackupClient.js", import.meta.url), "utf8")
    );

    const prepareIndex = source.indexOf("await prepareLocalDbForExternalRestore();");
    const writeIndex = source.indexOf("fs.writeFileSync(DB_SQLITE_FILE, backupData);");
    const reloadIndex = source.indexOf("await reloadLocalDbAfterExternalRestore();");

    expect(prepareIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(prepareIndex);
    expect(reloadIndex).toBeGreaterThan(writeIndex);
  });

  it("exposes dedicated local DB restore lifecycle hooks", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/lib/localDb.js", import.meta.url), "utf8")
    );

    expect(source).toContain("export async function prepareLocalDbForExternalRestore()");
    expect(source).toContain("closeSqliteDb();");
    expect(source).toContain("export async function reloadLocalDbAfterExternalRestore()");
    expect(source).toContain("await ensureSqliteBootstrap();");
    expect(source).toContain("await clearAllHotState();");
    expect(source).toContain("rebuildHotStateFromConnections(connectionsForRebuild);");
  });
});
