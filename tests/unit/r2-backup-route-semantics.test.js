import { describe, expect, it, vi, beforeEach } from "vitest";

const publishRuntimeArtifactsFromSettings = vi.fn();

vi.mock("@/lib/r2BackupClient", () => ({
  publishRuntimeArtifactsFromSettings,
}));

describe("/api/r2/backup semantics", () => {
  beforeEach(() => {
    publishRuntimeArtifactsFromSettings.mockReset();
  });

  it("reports unchanged sqlite backups without pretending a fresh upload happened", async () => {
    publishRuntimeArtifactsFromSettings.mockResolvedValue({
      backup: { ok: true, uploaded: true },
      runtime: { ok: true, uploaded: true },
      sqlite: { ok: true, uploaded: false, skipped: true },
    });

    const { POST } = await import("@/app/api/r2/backup/route.js");
    const response = await POST();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.backupReady).toBe(true);
    expect(body.sqliteUploaded).toBe(false);
    expect(body.sqliteSkipped).toBe(true);
    expect(body.backupOutcome).toBe("unchanged");
  });

  it("marks the backup outcome failed when sqlite publish fails", async () => {
    publishRuntimeArtifactsFromSettings.mockResolvedValue({
      backup: { ok: true, uploaded: true },
      runtime: { ok: true, uploaded: true },
      sqlite: { ok: false, uploaded: false, skipped: false, error: "sqlite upload failed" },
    });

    const { POST } = await import("@/app/api/r2/backup/route.js");
    const response = await POST();
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.backupReady).toBe(true);
    expect(body.sqliteUploaded).toBe(false);
    expect(body.sqliteSkipped).toBe(false);
    expect(body.backupOutcome).toBe("failed");
  });
});
