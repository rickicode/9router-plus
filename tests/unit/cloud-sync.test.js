import { beforeEach, describe, expect, it, vi } from "vitest";

const getSettings = vi.fn();
const atomicUpdateSettings = vi.fn();
const getActiveCloudEntry = vi.fn();
const refreshWorkerRuntime = vi.fn();
const publishRuntimeArtifactsFromSettings = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getSettings,
  atomicUpdateSettings,
}));

vi.mock("@/lib/cloudUrlResolver", () => ({
  getActiveCloudEntry,
}));

vi.mock("@/lib/cloudWorkerClient", () => ({
  refreshWorkerRuntime,
}));

vi.mock("@/lib/r2BackupClient", () => ({
  publishRuntimeArtifactsFromSettings,
}));

describe("cloudSync", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    atomicUpdateSettings.mockImplementation(async (mutator) => mutator({ cloudUrls: [] }));
    publishRuntimeArtifactsFromSettings.mockResolvedValue({
      backup: { ok: true },
      runtime: { ok: true },
      eligible: { ok: true },
      credentials: { ok: true },
      runtimeConfig: { ok: true },
      sqlite: { ok: true, skipped: true },
    });
  });

  it("publishes required runtime artifacts before refreshing cloud workers", async () => {
    getSettings.mockResolvedValue({
      r2Config: {
        accountId: "0123456789abcdef0123456789abcdef",
        endpoint: "https://acct.r2.cloudflarestorage.com",
        bucket: "bucket",
        accessKeyId: "key",
        secretAccessKey: "secret",
        region: "auto",
      },
      cloudSharedSecret: "global-secret-1",
      cloudUrls: [
        { id: "worker-1", url: "https://worker.example.com" },
      ],
    });
    refreshWorkerRuntime.mockResolvedValue({ success: true, refreshedAt: "2026-04-30T00:00:00.000Z" });

    const { syncToCloud } = await import("@/lib/cloudSync.js");
    const result = await syncToCloud();

    expect(publishRuntimeArtifactsFromSettings).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        r2Config: expect.objectContaining({ bucket: "bucket" }),
      }),
    });
    expect(refreshWorkerRuntime).toHaveBeenCalledWith(
      "https://worker.example.com",
      "global-secret-1"
    );
    expect(result).toMatchObject({
      success: true,
      workersOk: 1,
      workersFailed: 0,
      runtimeArtifactUpload: {
        credentials: { ok: true },
        runtimeConfig: { ok: true },
      },
    });
  });

  it("fails before worker refresh when private R2 is not configured", async () => {
    getSettings.mockResolvedValue({
      cloudSharedSecret: "global-secret-1",
      cloudUrls: [
        { id: "worker-1", url: "https://worker.example.com" },
      ],
    });

    const { syncToCloud } = await import("@/lib/cloudSync.js");

    await expect(syncToCloud()).rejects.toThrow(
      "Cloud sync requires a valid private R2 configuration so the worker runtime artifacts can be uploaded"
    );
    expect(publishRuntimeArtifactsFromSettings).not.toHaveBeenCalled();
    expect(refreshWorkerRuntime).not.toHaveBeenCalled();
  });

  it("fails before worker refresh when private R2 config is incomplete", async () => {
    getSettings.mockResolvedValue({
      r2Config: {
        accountId: "",
        endpoint: "https://acct.r2.cloudflarestorage.com",
        bucket: "bucket",
        accessKeyId: "key",
        secretAccessKey: "",
        region: "auto",
      },
      cloudSharedSecret: "global-secret-1",
      cloudUrls: [
        { id: "worker-1", url: "https://worker.example.com" },
      ],
    });

    const { syncToCloud } = await import("@/lib/cloudSync.js");

    await expect(syncToCloud()).rejects.toThrow(
      "Cloud sync requires a valid private R2 configuration so the worker runtime artifacts can be uploaded"
    );
    expect(publishRuntimeArtifactsFromSettings).not.toHaveBeenCalled();
    expect(refreshWorkerRuntime).not.toHaveBeenCalled();
  });

  it("fails before worker refresh when required runtime artifact uploads are incomplete", async () => {
    getSettings.mockResolvedValue({
      r2Config: {
        accountId: "0123456789abcdef0123456789abcdef",
        endpoint: "https://acct.r2.cloudflarestorage.com",
        bucket: "bucket",
        accessKeyId: "key",
        secretAccessKey: "secret",
        region: "auto",
      },
      cloudSharedSecret: "global-secret-1",
      cloudUrls: [
        { id: "worker-1", url: "https://worker.example.com" },
      ],
    });
    publishRuntimeArtifactsFromSettings.mockResolvedValue({
      backup: { ok: true },
      runtime: { ok: true },
      eligible: { ok: true },
      credentials: { ok: false, error: "credentials upload failed" },
      runtimeConfig: { ok: true },
      sqlite: { ok: true, skipped: true },
    });

    const { syncToCloud } = await import("@/lib/cloudSync.js");

    await expect(syncToCloud()).rejects.toThrow(
      "Cloud sync aborted: credentials: credentials upload failed"
    );
    expect(refreshWorkerRuntime).not.toHaveBeenCalled();
  });

  it("publishes artifacts before refreshing the active worker", async () => {
    getSettings.mockResolvedValue({
      r2Config: {
        accountId: "0123456789abcdef0123456789abcdef",
        endpoint: "https://acct.r2.cloudflarestorage.com",
        bucket: "bucket",
        accessKeyId: "key",
        secretAccessKey: "secret",
        region: "auto",
      },
      cloudSharedSecret: "global-secret-1",
    });
    getActiveCloudEntry.mockResolvedValue({
      id: "worker-1",
      url: "https://worker.example.com",
    });
    refreshWorkerRuntime.mockResolvedValue({ success: true, refreshedAt: "2026-04-30T00:00:00.000Z" });

    const { syncToCloudActive } = await import("@/lib/cloudSync.js");

    await expect(syncToCloudActive()).resolves.toMatchObject({ success: true });
    expect(publishRuntimeArtifactsFromSettings).toHaveBeenCalledTimes(1);
    expect(refreshWorkerRuntime).toHaveBeenCalledTimes(1);
  });
});
