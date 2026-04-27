import { beforeEach, describe, expect, it, vi } from "vitest";

const getSettings = vi.fn();
const publishRuntimeArtifactsFromSettings = vi.fn();
const backupUsageToAll = vi.fn();

vi.mock("@/lib/localDb.js", () => ({
  getSettings,
}));

vi.mock("@/lib/r2BackupClient.js", () => ({
  publishRuntimeArtifactsFromSettings,
  backupUsageToAll,
}));

describe("r2BackupScheduler", () => {
  beforeEach(() => {
    vi.resetModules();
    getSettings.mockReset();
    publishRuntimeArtifactsFromSettings.mockReset();
    backupUsageToAll.mockReset();
  });

  it("triggerSqliteBackupNow publishes direct R2 artifacts when auto publish is enabled", async () => {
    getSettings.mockResolvedValue({ r2AutoPublishEnabled: true, r2BackupEnabled: false });
    publishRuntimeArtifactsFromSettings.mockResolvedValue({
      backup: { ok: true, uploaded: true },
      runtime: { ok: true, uploaded: true },
      sqlite: { ok: true, skipped: true },
    });

    const { triggerSqliteBackupNow } = await import("@/lib/r2BackupScheduler.js");

    await triggerSqliteBackupNow();

    expect(publishRuntimeArtifactsFromSettings).toHaveBeenCalledTimes(1);
  });

  it("triggerSqliteBackupNow does not publish when both R2 backup toggles are off", async () => {
    getSettings.mockResolvedValue({ r2AutoPublishEnabled: false, r2BackupEnabled: false });

    const { triggerSqliteBackupNow } = await import("@/lib/r2BackupScheduler.js");

    await triggerSqliteBackupNow();

    expect(publishRuntimeArtifactsFromSettings).not.toHaveBeenCalled();
  });
});
