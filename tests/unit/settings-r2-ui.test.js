import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildR2SettingsPayload,
  getDirtyR2Config,
  getNextR2Config,
  getR2ConnectionState,
  hasUnsavedR2Changes,
  isPrivateR2Configured,
  isPrivateR2Ready,
  normalizeR2SettingsResponse,
  parseCloudflareR2Url,
  sanitizeR2RuntimeCacheTtlSeconds,
} from "../../src/app/(dashboard)/dashboard/settings/r2SettingsUi.js";

describe("settings R2 UI helpers", () => {
  it("renders region as a required settings field", async () => {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx"
    );
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).toContain('{ key: "region", label: "Region", required: true, autoComplete: "off" }');
  });

  it("parses a standard Cloudflare R2 bucket URL into account, endpoint, bucket, and region", () => {
    expect(
      parseCloudflareR2Url("https://f8ab5bbdd826db1b9aa1059d7842be75.r2.cloudflarestorage.com/9router")
    ).toEqual({
      accountId: "f8ab5bbdd826db1b9aa1059d7842be75",
      endpoint: "https://f8ab5bbdd826db1b9aa1059d7842be75.r2.cloudflarestorage.com",
      bucket: "9router",
      region: "auto",
    });
  });

  it("parses jurisdiction-specific Cloudflare R2 URLs", () => {
    expect(
      parseCloudflareR2Url("https://f8ab5bbdd826db1b9aa1059d7842be75.eu.r2.cloudflarestorage.com/bucket-a")
    ).toEqual({
      accountId: "f8ab5bbdd826db1b9aa1059d7842be75",
      endpoint: "https://f8ab5bbdd826db1b9aa1059d7842be75.eu.r2.cloudflarestorage.com",
      bucket: "bucket-a",
      region: "eu",
    });
  });

  it("ignores non-Cloudflare URLs when attempting R2 autofill", () => {
    expect(parseCloudflareR2Url("https://example.com/not-r2")).toBeNull();
  });

  it("auto-fills related config fields when an R2 URL is pasted into endpoint", () => {
    expect(
      getNextR2Config(
        {
          accountId: "",
          accessKeyId: "key",
          secretAccessKey: "secret",
          bucket: "",
          endpoint: "",
          region: "",
          publicUrl: "",
          connected: true,
          lastCheckedAt: "2026-04-26T00:00:00.000Z",
          lastError: "",
        },
        "https://f8ab5bbdd826db1b9aa1059d7842be75.r2.cloudflarestorage.com/9router",
        "endpoint"
      )
    ).toMatchObject({
      accountId: "f8ab5bbdd826db1b9aa1059d7842be75",
      bucket: "9router",
      endpoint: "https://f8ab5bbdd826db1b9aa1059d7842be75.r2.cloudflarestorage.com",
      region: "auto",
      connected: false,
      lastCheckedAt: null,
      lastError: "",
    });
  });

  it("mentions Cloudflare R2 URL autofill guidance on the settings page", async () => {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx"
    );
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).toContain("You can paste a Cloudflare R2 bucket URL into Endpoint or Public/Base URL");
    expect(source).toContain("getNextR2Config");
    expect(source).not.toContain("Load Buckets");
    expect(source).not.toContain("Detected buckets");
    expect(source).not.toContain("buildDefaultCloudflareR2Endpoint");
    expect(source).not.toContain("Account ID, Access Key ID, and Secret Access Key are required before loading buckets.");
  });

  it("normalizes API state and preserves a full PATCH payload contract", () => {
    const normalized = normalizeR2SettingsResponse({
      r2Config: {
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "bucket",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        publicUrl: "https://cdn.example.com",
        connected: true,
        lastCheckedAt: "2026-04-26T00:00:00.000Z",
        lastError: "",
      },
      r2BackupEnabled: true,
      r2SqliteBackupSchedule: "weekly",
      r2AutoPublishEnabled: true,
      r2RuntimePublicBaseUrl: "https://runtime.example.com/base",
      r2RuntimeCacheTtlSeconds: 30,
      r2LastRuntimePublishAt: "2026-04-26T03:15:00.000Z",
      r2LastBackupAt: "2026-04-25T12:00:00.000Z",
      r2LastRestoreAt: "2026-04-24T08:30:00.000Z",
    });

    expect(normalized).toMatchObject({
      r2BackupEnabled: true,
      r2SqliteBackupSchedule: "weekly",
      r2AutoPublishEnabled: true,
      r2RuntimePublicBaseUrl: "https://runtime.example.com/base",
      r2RuntimeCacheTtlSeconds: 30,
      r2LastRuntimePublishAt: "2026-04-26T03:15:00.000Z",
      r2LastBackupAt: "2026-04-25T12:00:00.000Z",
      r2LastRestoreAt: "2026-04-24T08:30:00.000Z",
    });

    expect(buildR2SettingsPayload(normalized)).toEqual({
      r2Config: {
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "bucket",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        publicUrl: "https://cdn.example.com",
        connected: true,
        lastCheckedAt: "2026-04-26T00:00:00.000Z",
        lastError: "",
      },
      r2BackupEnabled: true,
      r2SqliteBackupSchedule: "weekly",
      r2AutoPublishEnabled: true,
      r2RuntimePublicBaseUrl: "https://runtime.example.com/base",
      r2RuntimeCacheTtlSeconds: 30,
    });
  });

  it("treats backup, schedule, and runtime publishing changes as unsaved R2 changes", () => {
    const persisted = normalizeR2SettingsResponse({
      r2Config: {
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "bucket",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        connected: true,
      },
      r2BackupEnabled: false,
      r2SqliteBackupSchedule: "daily",
      r2AutoPublishEnabled: false,
      r2RuntimePublicBaseUrl: "",
      r2RuntimeCacheTtlSeconds: 15,
    });

    expect(
      hasUnsavedR2Changes(
        { ...persisted, r2BackupEnabled: true },
        persisted
      )
    ).toBe(true);
    expect(
      hasUnsavedR2Changes(
        { ...persisted, r2SqliteBackupSchedule: "weekly" },
        persisted
      )
    ).toBe(true);
    expect(
      hasUnsavedR2Changes(
        { ...persisted, r2AutoPublishEnabled: true },
        persisted
      )
    ).toBe(true);
    expect(
      hasUnsavedR2Changes(
        { ...persisted, r2RuntimePublicBaseUrl: "https://runtime.example.com/base" },
        persisted
      )
    ).toBe(true);
    expect(
      hasUnsavedR2Changes(
        { ...persisted, r2RuntimeCacheTtlSeconds: 60 },
        persisted
      )
    ).toBe(true);
  });

  it("omits r2Config from save payload when only backup settings changed", () => {
    const persisted = normalizeR2SettingsResponse({
      r2Config: {
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "bucket",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        connected: true,
        lastCheckedAt: "2026-04-26T00:00:00.000Z",
        lastError: "",
      },
      r2BackupEnabled: false,
      r2SqliteBackupSchedule: "daily",
      r2AutoPublishEnabled: false,
      r2RuntimePublicBaseUrl: "",
      r2RuntimeCacheTtlSeconds: 15,
    });

    expect(
      buildR2SettingsPayload(
        { ...persisted, r2BackupEnabled: true, r2SqliteBackupSchedule: "weekly" },
        persisted
      )
    ).toEqual({
      r2BackupEnabled: true,
      r2SqliteBackupSchedule: "weekly",
    });
  });

  it("includes only changed runtime publishing settings in the save payload", () => {
    const persisted = normalizeR2SettingsResponse({
      r2Config: {
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "bucket",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        connected: true,
      },
      r2BackupEnabled: false,
      r2SqliteBackupSchedule: "daily",
      r2AutoPublishEnabled: false,
      r2RuntimePublicBaseUrl: "",
      r2RuntimeCacheTtlSeconds: 15,
    });

    expect(
      buildR2SettingsPayload(
        {
          ...persisted,
          r2AutoPublishEnabled: true,
          r2RuntimePublicBaseUrl: "https://runtime.example.com/base",
          r2RuntimeCacheTtlSeconds: 45,
        },
        persisted
      )
    ).toEqual({
      r2BackupEnabled: false,
      r2SqliteBackupSchedule: "daily",
      r2AutoPublishEnabled: true,
      r2RuntimePublicBaseUrl: "https://runtime.example.com/base",
      r2RuntimeCacheTtlSeconds: 45,
    });
  });

  it("sanitizes runtime cache TTL input at the UI boundary", () => {
    expect(sanitizeR2RuntimeCacheTtlSeconds("45")).toBe(45);
    expect(sanitizeR2RuntimeCacheTtlSeconds("0")).toBe(1);
    expect(sanitizeR2RuntimeCacheTtlSeconds("999")).toBe(300);
    expect(sanitizeR2RuntimeCacheTtlSeconds("abc")).toBe(15);
    expect(sanitizeR2RuntimeCacheTtlSeconds("")).toBe(15);
  });

  it("does not silently drop runtime TTL edits during dirty and payload checks", () => {
    const persisted = normalizeR2SettingsResponse({
      r2RuntimeCacheTtlSeconds: 45,
    });
    const edited = {
      ...persisted,
      r2RuntimeCacheTtlSeconds: sanitizeR2RuntimeCacheTtlSeconds("0"),
    };

    expect(edited.r2RuntimeCacheTtlSeconds).toBe(1);
    expect(hasUnsavedR2Changes(edited, persisted)).toBe(true);
    expect(buildR2SettingsPayload(edited, persisted)).toMatchObject({
      r2RuntimeCacheTtlSeconds: 1,
    });
  });

  it("preserves previous backup timestamps when the save response omits them", async () => {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx"
    );
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).toContain("r2LastBackupAt: data.r2LastBackupAt ?? savedR2Settings.r2LastBackupAt");
    expect(source).toContain("r2LastRestoreAt: data.r2LastRestoreAt ?? savedR2Settings.r2LastRestoreAt");
  });

  it("preserves previous runtime publish timestamp when the save response omits it", async () => {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx"
    );
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).toContain("r2LastRuntimePublishAt:");
    expect(source).toContain("data.r2LastRuntimePublishAt ?? savedR2Settings.r2LastRuntimePublishAt");
  });

  it("adopts newer timestamps returned by the save response", async () => {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx"
    );
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).not.toContain("r2LastRuntimePublishAt: savedR2Settings.r2LastRuntimePublishAt");
    expect(source).not.toContain("r2LastBackupAt: savedR2Settings.r2LastBackupAt");
    expect(source).not.toContain("r2LastRestoreAt: savedR2Settings.r2LastRestoreAt");
  });

  it("renders backup and restore controls on the unified settings page", async () => {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx"
    );
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).toContain("Automatic backups");
    expect(source).toContain("Backup schedule");
    expect(source).toContain("Backup Now");
    expect(source).toContain("View R2 Status");
    expect(source).toContain("Restore from R2");
  });

  it("formats direct artifact backup results instead of worker counts", async () => {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx"
    );
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).toContain("formatDirectBackupMessage");
    expect(source).toContain("R2 publish complete");
    expect(source).toContain('formatArtifactState("runtime", data.runtime)');
    expect(source).not.toContain("successes || 0");
    expect(source).not.toContain("/0 workers");
  });

  it("formats direct R2 status summaries instead of worker reachability", async () => {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx"
    );
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).toContain("formatDirectR2Status");
    expect(source).toContain("data.status?.summary");
    expect(source).not.toContain("workers reachable");
    expect(source).not.toContain("data.workers");
  });

  it("renders runtime publishing controls in the existing R2 Storage card", async () => {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx"
    );
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).toContain("Runtime public base URL");
    expect(source).toContain("Runtime cache TTL");
    expect(source).toContain("Automatic runtime publish");
    expect(source).toContain("Last runtime publish");
  });

  it("sanitizes runtime cache TTL before updating Settings page state", async () => {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx"
    );
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).toContain("sanitizeR2RuntimeCacheTtlSeconds(event.target.value)");
    expect(source).not.toContain('Number(event.target.value || 0)');
  });

  it("treats region as required before the UI is ready to test", () => {
    expect(
      getR2ConnectionState({
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "bucket",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "",
      })
    ).toMatchObject({
      label: "Not configured",
      tone: "idle",
    });
  });

  it("marks edited credentials as unverified and preserves payload shape", () => {
    const dirtyConfig = getDirtyR2Config({
      accountId: "acct",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "bucket",
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
      publicUrl: "https://cdn.example.com",
      connected: true,
      lastCheckedAt: "2026-04-26T00:00:00.000Z",
      lastError: "",
    }, "bucket-2", "bucket");

    expect(dirtyConfig).toMatchObject({
      bucket: "bucket-2",
      connected: false,
      lastCheckedAt: null,
      lastError: "",
    });
    expect(getR2ConnectionState(dirtyConfig, false, true)).toMatchObject({
      label: "Unverified changes",
      tone: "ready",
    });
    expect(buildR2SettingsPayload({ r2Config: dirtyConfig })).toMatchObject({
      r2Config: expect.objectContaining({
        bucket: "bucket-2",
        connected: false,
        lastCheckedAt: null,
        lastError: "",
      }),
    });
  });

  it("returns clear text states for connected, failed, and testing cases", () => {
    expect(
      getR2ConnectionState({
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "bucket",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        connected: true,
        lastCheckedAt: "2026-04-26T00:00:00.000Z",
      })
    ).toMatchObject({
      label: "Connected",
      tone: "success",
    });

    expect(
      getR2ConnectionState({
        accountId: "acct",
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "bucket",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        connected: false,
        lastError: "Access denied",
        lastCheckedAt: "2026-04-26T00:00:00.000Z",
      })
    ).toMatchObject({
      label: "Connection failed",
      tone: "error",
    });

    expect(getR2ConnectionState({}, true)).toEqual({
      label: "Testing connection",
      tone: "pending",
      detail: "Checking the current R2 settings now.",
    });
  });

  it("distinguishes private R2 configuration from backup-ready state", () => {
    const configured = {
      accountId: "acct",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "bucket",
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
    };

    expect(isPrivateR2Configured(configured)).toBe(true);
    expect(isPrivateR2Ready({ ...configured, connected: false }, false)).toBe(false);
    expect(isPrivateR2Ready({ ...configured, connected: true }, true)).toBe(false);
    expect(isPrivateR2Ready({ ...configured, connected: true }, false)).toBe(true);
  });

  it("wires restore through explicit confirmation and stronger readiness gating", async () => {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx"
    );
    const source = await fs.readFile(pagePath, "utf8");

    expect(source).toContain("confirmRestore: true");
    expect(source).toContain("Restore candidate:");
    expect(source).toContain("Run a successful connection test before using backup, status, or restore actions.");
    expect(source).toContain("disabled={!canRestoreFromR2}");
    expect(source).toContain("disabled={!canOperateR2Backup}");
    expect(source).toContain("disabled={!canViewR2Status}");
  });
});
