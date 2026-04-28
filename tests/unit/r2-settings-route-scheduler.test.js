import { beforeEach, describe, expect, it, vi } from "vitest";

const getSettings = vi.fn();
const updateSettings = vi.fn();
const startR2BackupScheduler = vi.fn();
const stopR2BackupScheduler = vi.fn();
const updateSqliteBackupSchedule = vi.fn();
const registerWithWorker = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getSettings,
  updateSettings,
}));

vi.mock("@/lib/r2BackupScheduler", () => ({
  startR2BackupScheduler,
  stopR2BackupScheduler,
  updateSqliteBackupSchedule,
}));

vi.mock("@/lib/cloudWorkerClient", () => ({
  registerWithWorker,
}));

describe("/api/r2 scheduler coordination", () => {
  beforeEach(() => {
    vi.resetModules();
    getSettings.mockReset();
    updateSettings.mockReset();
    startR2BackupScheduler.mockReset();
    stopR2BackupScheduler.mockReset();
    updateSqliteBackupSchedule.mockReset();
    registerWithWorker.mockReset();
  });

  it("starts the scheduler when scheduled backups are enabled", async () => {
    getSettings.mockResolvedValue({ cloudUrls: [] });
    updateSettings.mockResolvedValue({
      cloudUrls: [],
      r2BackupEnabled: true,
      r2SqliteBackupSchedule: "weekly",
      r2AutoPublishEnabled: false,
      r2RuntimePublicBaseUrl: "",
      r2RuntimeCacheTtlSeconds: 15,
      r2Config: {},
    });

    const { PATCH } = await import("@/app/api/r2/route.js");
    const request = new Request("http://localhost/api/r2", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ r2BackupEnabled: true, r2SqliteBackupSchedule: "weekly" }),
    });

    const response = await PATCH(request);
    expect(response.status).toBe(200);
    expect(startR2BackupScheduler).toHaveBeenCalledTimes(1);
    expect(updateSqliteBackupSchedule).toHaveBeenCalledTimes(1);
    expect(stopR2BackupScheduler).not.toHaveBeenCalled();
  });

  it("stops the scheduler when scheduled backups are disabled even if auto publish remains enabled", async () => {
    getSettings.mockResolvedValue({ cloudUrls: [] });
    updateSettings.mockResolvedValue({
      cloudUrls: [],
      r2BackupEnabled: false,
      r2SqliteBackupSchedule: "daily",
      r2AutoPublishEnabled: true,
      r2RuntimePublicBaseUrl: "https://storage.example.com/runtime/app",
      r2RuntimeCacheTtlSeconds: 15,
      r2Config: {},
    });

    const { PATCH } = await import("@/app/api/r2/route.js");
    const request = new Request("http://localhost/api/r2", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ r2BackupEnabled: false, r2AutoPublishEnabled: true }),
    });

    const response = await PATCH(request);
    expect(response.status).toBe(200);
    expect(stopR2BackupScheduler).toHaveBeenCalledTimes(1);
    expect(startR2BackupScheduler).not.toHaveBeenCalled();
    expect(updateSqliteBackupSchedule).not.toHaveBeenCalled();
  });
});
