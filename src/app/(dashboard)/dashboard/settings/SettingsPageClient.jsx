"use client";

import { useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import PricingModal from "@/shared/components/PricingModal";
import ProfileSettingsContent from "@/shared/components/settings/ProfileSettingsContent";
import {
  buildR2SettingsPayload,
  DEFAULT_R2_SETTINGS_RESPONSE,
  getDirtyR2Config,
  getR2ConnectionState,
  hasUnsavedR2Changes,
  normalizeR2SettingsResponse,
  sanitizeR2RuntimeCacheTtlSeconds,
} from "./r2SettingsUi";

const R2_FIELD_DEFINITIONS = [
  { key: "accountId", label: "Account ID", required: true, autoComplete: "off" },
  { key: "accessKeyId", label: "Access Key ID", required: true, autoComplete: "off" },
  {
    key: "secretAccessKey",
    label: "Secret Access Key",
    required: true,
    autoComplete: "off",
    type: "password",
  },
  { key: "bucket", label: "Bucket Name", required: true, autoComplete: "off" },
  { key: "endpoint", label: "Endpoint", required: true, autoComplete: "url" },
  { key: "region", label: "Region", required: true, autoComplete: "off" },
  { key: "publicUrl", label: "Public/Base URL", autoComplete: "url" },
];

const STATUS_TONE_CLASSNAMES = {
  idle: "border-[var(--color-border)] bg-[var(--color-bg-alt)] text-[var(--color-text-muted)]",
  ready: "border-[var(--color-border)] bg-[var(--color-bg-alt)] text-[var(--color-text-main)]",
  pending: "border-[var(--color-primary)]/30 bg-[var(--color-primary)]/10 text-[var(--color-text-main)]",
  success: "border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-text-main)]",
  error: "border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-text-main)]",
};

const BACKUP_SCHEDULE_OPTIONS = ["daily", "weekly", "monthly"];

function formatRelativeTimestamp(value, fallback) {
  if (!value) return fallback;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString();
}

function formatArtifactState(label, artifact) {
  if (!artifact) return `${label} unavailable`;
  if (artifact.skipped) return `${label} skipped`;
  if (artifact.uploaded || artifact.ok) return `${label} uploaded`;
  return `${label} failed`;
}

function formatDirectBackupMessage(data = {}) {
  const parts = [
    formatArtifactState("backup", data.backup),
    formatArtifactState("runtime", data.runtime),
    formatArtifactState("SQLite", data.sqlite),
  ];

  return data.success
    ? `R2 publish complete: ${parts.join(", ")}.`
    : `R2 publish finished with issues: ${parts.join(", ")}.`;
}

function formatDirectR2Status(data = {}) {
  if (data.status?.summary) return data.status.summary;
  if (!data.configured) return "R2 direct runtime storage is not configured.";

  const backupAt = formatRelativeTimestamp(data.r2LastBackupAt, "not recorded");
  const runtimeAt = formatRelativeTimestamp(data.r2LastRuntimePublishAt, "not recorded");
  return `Direct R2 status loaded. Last backup ${backupAt}. Last runtime publish ${runtimeAt}.`;
}

export default function SettingsPageClient() {
  const [showPricingModal, setShowPricingModal] = useState(false);
  const [currentPricing, setCurrentPricing] = useState(null);
  const [loadingPricing, setLoadingPricing] = useState(true);
  const [r2Settings, setR2Settings] = useState(DEFAULT_R2_SETTINGS_RESPONSE);
  const [savedR2Settings, setSavedR2Settings] = useState(DEFAULT_R2_SETTINGS_RESPONSE);
  const [loadingR2, setLoadingR2] = useState(true);
  const [savingR2, setSavingR2] = useState(false);
  const [testingR2, setTestingR2] = useState(false);
  const [r2Feedback, setR2Feedback] = useState({ type: "", message: "" });
  const [runningBackup, setRunningBackup] = useState(false);
  const [loadingR2Status, setLoadingR2Status] = useState(false);
  const [restoringR2, setRestoringR2] = useState(false);
  const [r2ActionFeedback, setR2ActionFeedback] = useState({ type: "", message: "" });
  const [r2StatusSummary, setR2StatusSummary] = useState("");

  useEffect(() => {
    loadPricing();
    loadR2Settings();
  }, []);

  const loadPricing = async () => {
    setLoadingPricing(true);
    try {
      const response = await fetch("/api/pricing");
      if (!response.ok) {
        setCurrentPricing(null);
        return;
      }

      const data = await response.json();
      setCurrentPricing(data);
    } catch (error) {
      console.error("Failed to load pricing:", error);
      setCurrentPricing(null);
    } finally {
      setLoadingPricing(false);
    }
  };

  const loadR2Settings = async () => {
    setLoadingR2(true);
    try {
      const response = await fetch("/api/r2");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to load R2 settings");
      }

      const normalized = normalizeR2SettingsResponse(data);
      setSavedR2Settings(normalized);
      setR2Settings(normalized);
    } catch (error) {
      console.error("Failed to load R2 settings:", error);
      setR2Feedback({ type: "error", message: error.message || "Failed to load R2 settings" });
      setR2Settings(DEFAULT_R2_SETTINGS_RESPONSE);
      setSavedR2Settings(DEFAULT_R2_SETTINGS_RESPONSE);
    } finally {
      setLoadingR2(false);
    }
  };

  const handleR2FieldChange = (field, value) => {
    setR2Settings((current) => ({
      ...current,
      r2Config: getDirtyR2Config(current.r2Config, value, field),
    }));
  };

  const handleR2SettingsChange = (field, value) => {
    setR2Settings((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleSaveR2Settings = async () => {
    setSavingR2(true);
    setR2Feedback({ type: "", message: "" });
    try {
      const response = await fetch("/api/r2", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildR2SettingsPayload(r2Settings, savedR2Settings)),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to save R2 settings");
      }

      const normalized = normalizeR2SettingsResponse({
        ...savedR2Settings,
        ...data,
        r2Config: data.r2Config || savedR2Settings.r2Config,
        r2LastRuntimePublishAt:
          data.r2LastRuntimePublishAt ?? savedR2Settings.r2LastRuntimePublishAt,
        r2LastBackupAt: data.r2LastBackupAt ?? savedR2Settings.r2LastBackupAt,
        r2LastRestoreAt: data.r2LastRestoreAt ?? savedR2Settings.r2LastRestoreAt,
      });
      setSavedR2Settings(normalized);
      setR2Settings(normalized);
      setR2Feedback({ type: "success", message: "R2 settings saved." });
    } catch (error) {
      setR2Feedback({ type: "error", message: error.message || "Failed to save R2 settings" });
    } finally {
      setSavingR2(false);
    }
  };

  const handleTestR2Connection = async () => {
    if (hasUnsavedR2Changes(r2Settings, savedR2Settings)) {
      setR2Feedback({
        type: "error",
        message: "Save your R2 changes before testing the persisted connection.",
      });
      return;
    }

    setTestingR2(true);
    setR2Feedback({ type: "", message: "" });
    try {
      const response = await fetch("/api/r2/test", { method: "POST" });
      const data = await response.json().catch(() => ({}));

      await loadR2Settings();

      if (!response.ok) {
        throw new Error(data.error || "Connection test failed");
      }

      setR2Feedback({ type: "success", message: "R2 connection verified." });
    } catch (error) {
      setR2Feedback({ type: "error", message: error.message || "Connection test failed" });
    } finally {
      setTestingR2(false);
    }
  };

  const handleBackupNow = async () => {
    setRunningBackup(true);
    setR2ActionFeedback({ type: "", message: "" });
    try {
      const response = await fetch("/api/r2/backup", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      await loadR2Settings();

      if (!response.ok) {
        throw new Error(data.error || "Backup failed");
      }

      const message = data.error || formatDirectBackupMessage(data);
      setR2ActionFeedback({
        type: data.success ? "success" : "error",
        message,
      });
    } catch (error) {
      setR2ActionFeedback({ type: "error", message: error.message || "Backup failed" });
    } finally {
      setRunningBackup(false);
    }
  };

  const handleViewR2Status = async () => {
    setLoadingR2Status(true);
    setR2ActionFeedback({ type: "", message: "" });
    try {
      const response = await fetch("/api/r2/info");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to load R2 status");
      }

      setR2StatusSummary(formatDirectR2Status(data));
      setR2ActionFeedback({ type: "success", message: "R2 status loaded." });
    } catch (error) {
      setR2StatusSummary("");
      setR2ActionFeedback({ type: "error", message: error.message || "Failed to load R2 status" });
    } finally {
      setLoadingR2Status(false);
    }
  };

  const handleRestoreFromR2 = async () => {
    setRestoringR2(true);
    setR2ActionFeedback({ type: "", message: "" });
    try {
      const restoreListResponse = await fetch("/api/r2/restore");
      const restoreListData = await restoreListResponse.json().catch(() => ({}));
      if (!restoreListResponse.ok) {
        throw new Error(restoreListData.error || "Failed to load restore information");
      }

      const response = await fetch("/api/r2/restore", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      await loadR2Settings();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Restore failed");
      }

      const backupCount = Array.isArray(restoreListData.backups) ? restoreListData.backups.length : 0;
      setR2ActionFeedback({
        type: "success",
        message: `Restore complete from ${restoreListData.workerName || "R2"} (${backupCount} backups available).`,
      });
    } catch (error) {
      setR2ActionFeedback({ type: "error", message: error.message || "Restore failed" });
    } finally {
      setRestoringR2(false);
    }
  };

  const getModelCount = () => {
    if (!currentPricing) return 0;

    return Object.values(currentPricing).reduce((count, providerPricing) => {
      if (!providerPricing || typeof providerPricing !== "object") return count;
      return count + Object.keys(providerPricing).length;
    }, 0);
  };

  const providerNames = currentPricing ? Object.keys(currentPricing).sort() : [];
  const r2IsDirty = hasUnsavedR2Changes(r2Settings, savedR2Settings);
  const r2ConnectionState = getR2ConnectionState(r2Settings.r2Config, testingR2, r2IsDirty);
  const feedbackToneClassName =
    r2Feedback.type === "error"
      ? "border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-text-main)]"
      : "border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-text-main)]";
  const actionFeedbackToneClassName =
    r2ActionFeedback.type === "error"
      ? "border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-text-main)]"
      : "border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-text-main)]";
  const r2Busy = savingR2 || testingR2 || runningBackup || restoringR2 || loadingR2Status;
  const pricingSummary = [
    {
      label: "General Controls",
      value: "7",
      tone: "text-[var(--color-primary)]",
      detail: "Workspace behavior, security, routing, quota",
    },
    {
      label: "R2 Actions",
      value: "5",
      tone: "text-[var(--color-info)]",
      detail: "Connection, publish, backup, restore, status",
    },
    {
      label: "Providers",
      value: loadingPricing ? "..." : String(providerNames.length),
      tone: "text-[var(--color-success)]",
      detail: "Pricing overrides available in one rail",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Card className="border border-border">
        <div className="flex flex-col gap-6">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-[var(--color-bg-alt)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
              <span className="material-symbols-outlined text-[14px]">tune</span>
              Settings
            </div>
            <h1 className="mt-3 text-2xl font-semibold text-text-main sm:text-3xl">
              Satu tempat untuk workspace, cloud routing, storage, dan pricing.
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">
              Semua konfigurasi utama sekarang hidup di halaman ini supaya operasional lokal, aturan worker,
              R2 lifecycle, dan kebijakan pricing tetap konsisten dengan shell dashboard yang sama.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {pricingSummary.map((item) => (
              <div key={item.label} className="rounded border border-border bg-[var(--color-bg-alt)] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
                  {item.label}
                </p>
                <p className={`mt-2 text-2xl font-semibold ${item.tone}`}>{item.value}</p>
                <p className="mt-1 text-sm leading-6 text-text-muted">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_340px]">
        <div className="space-y-6">
          <Card
            title="Workspace Settings"
            subtitle="Authentication, routing, quota, observability, and local runtime behavior"
            className="border border-border"
          >
            <div className="mb-5 flex flex-wrap gap-2 border-b border-[var(--color-border)] pb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
              <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-1">General</span>
              <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-1">Cloud Routing</span>
              <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-1">Security</span>
              <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-1">Quota</span>
            </div>
            <ProfileSettingsContent />
          </Card>

          <Card
            title="R2 Storage"
            subtitle="Connection details, runtime publishing, backup schedule, and restore controls"
            className="border border-border"
          >
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Connection</p>
                  <p className="mt-2 text-lg font-semibold text-[var(--color-text-main)]">{r2ConnectionState.label}</p>
                </div>
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Last Backup</p>
                  <p className="mt-2 text-lg font-semibold text-[var(--color-text-main)]">{formatRelativeTimestamp(r2Settings.r2LastBackupAt, "Not recorded")}</p>
                </div>
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Last Publish</p>
                  <p className="mt-2 text-lg font-semibold text-[var(--color-text-main)]">{formatRelativeTimestamp(r2Settings.r2LastRuntimePublishAt, "Not recorded")}</p>
                </div>
              </div>

              <div
                className={`rounded border p-4 ${STATUS_TONE_CLASSNAMES[r2ConnectionState.tone]}`}
                role="status"
                aria-live="polite"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em]">
                      Connection Status
                    </p>
                    <p className="mt-1 text-lg font-semibold text-[var(--color-text-main)]">
                      {r2ConnectionState.label}
                    </p>
                  </div>
                  <span className="rounded border border-current/20 px-3 py-1 text-xs font-medium uppercase tracking-[0.12em]">
                    {r2ConnectionState.tone}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-6">{r2ConnectionState.detail}</p>
              </div>

              {r2Feedback.message ? (
                <div
                  className={`rounded border p-3 text-sm leading-6 ${feedbackToneClassName}`}
                  role="status"
                  aria-live="polite"
                >
                  {r2Feedback.message}
                </div>
              ) : null}

              {r2ActionFeedback.message ? (
                <div
                  className={`rounded border p-3 text-sm leading-6 ${actionFeedbackToneClassName}`}
                  role="status"
                  aria-live="polite"
                >
                  {r2ActionFeedback.message}
                </div>
              ) : null}

              {loadingR2 ? (
                <div className="rounded border border-dashed border-[var(--color-border)] px-4 py-6 text-sm text-[var(--color-text-muted)]">
                  Loading R2 settings...
                </div>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {R2_FIELD_DEFINITIONS.map((field) => (
                      <label key={field.key} className="space-y-2 text-sm text-[var(--color-text-main)]">
                        <span className="block font-medium">
                          {field.label}
                          {field.required ? <span aria-hidden="true"> *</span> : null}
                        </span>
                        <input
                          type={field.type || "text"}
                          value={r2Settings.r2Config[field.key] || ""}
                          onChange={(event) => handleR2FieldChange(field.key, event.target.value)}
                          autoComplete={field.autoComplete}
                          disabled={r2Busy}
                          spellCheck={false}
                          className="min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-sm text-[var(--color-text-main)] outline-none transition focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30"
                        />
                      </label>
                    ))}
                  </div>

                  <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4 text-sm leading-6 text-[var(--color-text-muted)]">
                    <p>
                      Save resets the connection validation state until you run a new test, because the
                      API treats changed credentials as unverified.
                    </p>
                    {r2IsDirty ? (
                      <p className="mt-2">Test Connection stays disabled until these edits are saved.</p>
                    ) : null}
                  </div>

                  <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="space-y-4 sm:col-span-2">
                      <div className="space-y-1">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                          Runtime publishing
                        </p>
                        <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                          Control the public runtime URL, cache TTL, and automatic runtime publishes from this page.
                        </p>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="space-y-2 text-sm text-[var(--color-text-main)]">
                          <span className="block font-medium">Runtime public base URL</span>
                          <input
                            type="url"
                            value={r2Settings.r2RuntimePublicBaseUrl}
                            onChange={(event) =>
                              handleR2SettingsChange("r2RuntimePublicBaseUrl", event.target.value)
                            }
                            autoComplete="url"
                            disabled={r2Busy}
                            className="min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-sm text-[var(--color-text-main)] outline-none transition focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30"
                          />
                        </label>

                        <label className="space-y-2 text-sm text-[var(--color-text-main)]">
                          <span className="block font-medium">Runtime cache TTL</span>
                          <input
                            type="number"
                            min="1"
                            max="300"
                            value={r2Settings.r2RuntimeCacheTtlSeconds}
                            onChange={(event) =>
                              handleR2SettingsChange(
                                "r2RuntimeCacheTtlSeconds",
                                sanitizeR2RuntimeCacheTtlSeconds(event.target.value)
                              )
                            }
                            disabled={r2Busy}
                            className="min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-sm text-[var(--color-text-main)] outline-none transition focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30"
                          />
                        </label>
                      </div>

                      <label className="flex gap-3 text-sm text-[var(--color-text-main)] rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
                        <input
                          type="checkbox"
                          checked={r2Settings.r2AutoPublishEnabled}
                          onChange={(event) =>
                            handleR2SettingsChange("r2AutoPublishEnabled", event.target.checked)
                          }
                          disabled={r2Busy}
                          className="mt-1 h-4 w-4 rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                        />
                        <span className="space-y-1">
                          <span className="block font-medium">Automatic runtime publish</span>
                          <span className="block leading-6 text-[var(--color-text-muted)]">
                            Publish runtime artifacts automatically after eligible R2 backup runs.
                          </span>
                        </span>
                      </label>

                      <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                        Last runtime publish: {formatRelativeTimestamp(r2Settings.r2LastRuntimePublishAt, "Not recorded")}
                      </p>
                    </div>

                    <label className="space-y-2 text-sm text-[var(--color-text-main)]">
                       <span className="block font-medium">Automatic backups</span>
                       <select
                        value={r2Settings.r2BackupEnabled ? "enabled" : "disabled"}
                        onChange={(event) =>
                          handleR2SettingsChange("r2BackupEnabled", event.target.value === "enabled")
                        }
                        disabled={r2Busy}
                        className="min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-sm text-[var(--color-text-main)] outline-none transition focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30"
                      >
                        <option value="disabled">Disabled</option>
                        <option value="enabled">Enabled</option>
                      </select>
                    </label>

                    <label className="space-y-2 text-sm text-[var(--color-text-main)]">
                      <span className="block font-medium">Backup schedule</span>
                      <select
                        value={r2Settings.r2SqliteBackupSchedule}
                        onChange={(event) =>
                          handleR2SettingsChange("r2SqliteBackupSchedule", event.target.value)
                        }
                        disabled={r2Busy}
                        className="min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-sm text-[var(--color-text-main)] outline-none transition focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30"
                      >
                        {BACKUP_SCHEDULE_OPTIONS.map((schedule) => (
                          <option key={schedule} value={schedule}>
                            {schedule.charAt(0).toUpperCase() + schedule.slice(1)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="space-y-2 text-sm leading-6 text-[var(--color-text-muted)] sm:col-span-2">
                      <p>
                        Last backup: {formatRelativeTimestamp(r2Settings.r2LastBackupAt, "Not recorded")}
                      </p>
                      <p>
                        Last restore: {formatRelativeTimestamp(r2Settings.r2LastRestoreAt, "Not recorded")}
                      </p>
                      {r2StatusSummary ? <p>{r2StatusSummary}</p> : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button onClick={handleSaveR2Settings} disabled={r2Busy}>
                      {savingR2 ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={handleTestR2Connection}
                      disabled={loadingR2 || savingR2 || testingR2 || r2IsDirty}
                    >
                      {testingR2 ? "Testing..." : "Test Connection"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={handleBackupNow}
                      disabled={loadingR2 || savingR2 || testingR2 || runningBackup || restoringR2 || r2IsDirty}
                    >
                      {runningBackup ? "Backing Up..." : "Backup Now"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={handleViewR2Status}
                      disabled={loadingR2 || savingR2 || testingR2 || loadingR2Status || restoringR2 || r2IsDirty}
                    >
                      {loadingR2Status ? "Loading Status..." : "View R2 Status"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={handleRestoreFromR2}
                      disabled={loadingR2 || savingR2 || testingR2 || runningBackup || restoringR2 || r2IsDirty}
                    >
                      {restoringR2 ? "Restoring..." : "Restore from R2"}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-6 xl:self-start">
          <Card
            title="Pricing"
            subtitle="Cost tracking rates and model pricing overrides"
            action={
              <Button onClick={() => setShowPricingModal(true)}>
                Edit Pricing
              </Button>
            }
            className="border border-border"
          >
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                    Total Models
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-[var(--color-text-main)]">
                    {loadingPricing ? "..." : getModelCount()}
                  </div>
                </div>
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                    Providers
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-[var(--color-text-main)]">
                    {loadingPricing ? "..." : providerNames.length}
                  </div>
                </div>
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                    Status
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-[var(--color-success)]">
                    {loadingPricing ? "..." : "Active"}
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4 text-sm leading-6 text-[var(--color-text-muted)]">
                <p>
                  <strong className="text-[var(--color-text-main)]">Cost calculation:</strong> each
                  request uses input, output, and cached token rates to estimate spend.
                </p>
                <p>
                  <strong className="text-[var(--color-text-main)]">Pricing format:</strong> all
                  values are stored as dollars per million tokens ($/1M tokens).
                </p>
                <p>
                  <strong className="text-[var(--color-text-main)]">Migration note:</strong> the old
                  dedicated pricing page now points here so existing workflows continue without a split
                  settings experience.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold text-[var(--color-text-main)]">
                    Current Pricing Overview
                  </h2>
                  <Button variant="ghost" size="sm" onClick={() => setShowPricingModal(true)}>
                    View Full Details
                  </Button>
                </div>

                {loadingPricing ? (
                  <div className="rounded border border-dashed border-[var(--color-border)] px-4 py-6 text-sm text-[var(--color-text-muted)]">
                    Loading pricing data...
                  </div>
                ) : currentPricing ? (
                  <div className="space-y-3 rounded border border-[var(--color-border)] p-4">
                    {providerNames.slice(0, 5).map((provider) => (
                      <div key={provider} className="flex items-center justify-between gap-4 text-sm">
                        <span className="font-semibold uppercase text-[var(--color-text-main)]">
                          {provider}
                        </span>
                        <span className="text-[var(--color-text-muted)]">
                          {Object.keys(currentPricing[provider]).length} models
                        </span>
                      </div>
                    ))}
                    {providerNames.length > 5 ? (
                      <div className="text-sm text-[var(--color-text-muted)]">
                        + {providerNames.length - 5} more providers
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded border border-dashed border-[var(--color-border)] px-4 py-6 text-sm text-[var(--color-text-muted)]">
                    No pricing data available.
                  </div>
                )}
              </div>
            </div>

            {showPricingModal ? (
              <PricingModal
                isOpen={showPricingModal}
                onClose={() => setShowPricingModal(false)}
                onSave={loadPricing}
              />
            ) : null}
          </Card>

          <Card
            title="What lives here"
            subtitle="Quick scope map"
            className="border border-border"
          >
            <div className="divide-y divide-[var(--color-border)] text-sm leading-6 text-[var(--color-text-muted)]">
              <div className="py-3 first:pt-0">
                <p><strong className="text-[var(--color-text-main)]">Workspace:</strong> theme, login, proxy, observability, quota, and worker routing.</p>
              </div>
              <div className="py-3">
                <p><strong className="text-[var(--color-text-main)]">Storage:</strong> R2 credentials, runtime publishing, backup cadence, status, and restore.</p>
              </div>
              <div className="py-3 last:pb-0">
                <p><strong className="text-[var(--color-text-main)]">Pricing:</strong> provider cost overrides and live overview in the side rail.</p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
