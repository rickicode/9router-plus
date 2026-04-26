"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import GlassCard from "./shared/GlassCard";
import StatusBadge from "./shared/StatusBadge";
import ToggleRow from "./shared/ToggleRow";
import SectionHeader from "./shared/SectionHeader";

const STATUS_LABELS = {
  online: { label: "Online", color: "#10b981" },
  offline: { label: "Offline", color: "#6b7280" },
  error: { label: "Error", color: "#ef4444" },
  unauthorized: { label: "Unauthorized", color: "#f59e0b" },
  not_registered: { label: "Not Registered", color: "#f59e0b" },
  unknown: { label: "Unknown", color: "#6b7280" },
};

function formatRelative(iso) {
  if (!iso) return "never";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "never";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function StatusPill({ status, latencyMs }) {
  const cfg = STATUS_LABELS[status] || STATUS_LABELS.unknown;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: `${cfg.color}1a`,
        color: cfg.color,
        textTransform: "uppercase",
        letterSpacing: ".04em",
      }}
    >
      <span
        style={{ width: 6, height: 6, borderRadius: "50%", background: cfg.color }}
      />
      {cfg.label}
      {typeof latencyMs === "number" ? ` · ${latencyMs}ms` : ""}
    </span>
  );
}

function getLastSyncLabel(entry, workerStatus) {
  const lastSyncAt = entry.lastSyncAt || workerStatus?.lastSyncAt;
  if (lastSyncAt) return formatRelative(lastSyncAt);
  if (entry.lastSyncOk === false) return "initial sync failed";
  if (entry.registeredAt) return "initial sync pending";
  return "never";
}

function getLastSyncStyle(entry, workerStatus) {
  const lastSyncAt = entry.lastSyncAt || workerStatus?.lastSyncAt;
  if (lastSyncAt) return undefined;
  if (entry.lastSyncOk === false) return { color: "#fca5a5" };
  if (entry.registeredAt) return { color: "#fcd34d" };
  return undefined;
}

function getWorkerMessage(entry, workerError, workerStatus) {
  if (entry.lastSyncError) return entry.lastSyncError;
  if (workerError) return workerError;
  if (!(entry.lastSyncAt || workerStatus?.lastSyncAt) && entry.lastSyncOk === false) {
    return "Retry sync to push your latest providers and config.";
  }
  if (!(entry.lastSyncAt || workerStatus?.lastSyncAt) && entry.registeredAt) {
    return "Worker is registered. Initial sync is pending.";
  }
  return "";
}

function getWorkerMessageStyle(entry, workerError, workerStatus) {
  if (entry.lastSyncError || workerError || entry.lastSyncOk === false) {
    return { color: "#fca5a5" };
  }
  if (!(entry.lastSyncAt || workerStatus?.lastSyncAt) && entry.registeredAt) {
    return { color: "#fcd34d" };
  }
  return undefined;
}

export default function CloudTab() {
  const [workerSettings, setWorkerSettings] = useState({
    roundRobin: false,
    sticky: false,
    stickyDuration: 300,
  });
  const [cloudUrls, setCloudUrls] = useState([]);
  const [statusByUrl, setStatusByUrl] = useState({});
  const [newCloudUrl, setNewCloudUrl] = useState("");
  const [newCloudName, setNewCloudName] = useState("");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncingId, setSyncingId] = useState(null);
  const [revealedSecrets, setRevealedSecrets] = useState({});
  const [loadingSecretId, setLoadingSecretId] = useState(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsUrl, setTsUrl] = useState("");
  const [r2BackupEnabled, setR2BackupEnabled] = useState(false);
  const [r2SqliteBackupSchedule, setR2SqliteBackupSchedule] = useState("daily");
  const [r2Info, setR2Info] = useState(null);
  const [r2Backups, setR2Backups] = useState([]);
  const [r2Loading, setR2Loading] = useState(false);
  const [r2Backing, setR2Backing] = useState(false);
  const [r2Restoring, setR2Restoring] = useState(false);
  const [r2LastBackupAt, setR2LastBackupAt] = useState(null);
  const [r2Error, setR2Error] = useState("");
  const [r2InfoMessage, setR2InfoMessage] = useState("");

  const pollTimerRef = useRef(null);
  const { copied, copy } = useCopyToClipboard();

  const loadSettings = useCallback(async () => {
    try {
      const [settingsRes, tunnelRes, cloudUrlsRes, r2Res] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/tunnel/status"),
        fetch("/api/cloud-urls"),
        fetch("/api/r2"),
      ]);

      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setWorkerSettings({
          roundRobin: data.roundRobin || false,
          sticky: data.sticky || false,
          stickyDuration: data.stickyDuration || 300,
        });
      }

      if (tunnelRes.ok) {
        const data = await tunnelRes.json();
        setTunnelEnabled(data.tunnel?.enabled || false);
        setTunnelUrl(data.tunnel?.publicUrl || data.tunnel?.tunnelUrl || "");
        setTsEnabled(data.tailscale?.enabled || false);
        setTsUrl(data.tailscale?.tunnelUrl || "");
      }

      if (cloudUrlsRes.ok) {
        const data = await cloudUrlsRes.json();
        setCloudUrls(Array.isArray(data.cloudUrls) ? data.cloudUrls : []);
      }

      if (r2Res.ok) {
        const data = await r2Res.json();
        setR2BackupEnabled(data.r2BackupEnabled || false);
        setR2SqliteBackupSchedule(data.r2SqliteBackupSchedule || "daily");
        setR2LastBackupAt(data.r2LastBackupAt || null);
      }
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  }, []);

  const refreshAllStatuses = useCallback(async (entries) => {
    const list = entries || cloudUrls;
    const ids = list.map((c) => c.id);
    if (ids.length === 0) {
      setStatusByUrl({});
      return;
    }

    const results = await Promise.allSettled(
      ids.map((id) =>
        fetch(`/api/cloud-urls/${id}/status`).then((r) =>
          r.json().then((b) => [id, b, r.ok])
        )
      )
    );

    const next = {};
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const [id, body, ok] = result.value;
      next[id] = ok ? body : { error: body?.error || "fetch failed" };
    }
    setStatusByUrl(next);
  }, [cloudUrls]);

  useEffect(() => {
    loadSettings();
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [loadSettings]);

  const cloudIdsKey = cloudUrls.map((c) => c.id).join(",");
  useEffect(() => {
    if (!cloudIdsKey) return;
    refreshAllStatuses();
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(refreshAllStatuses, 30_000);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [cloudIdsKey, refreshAllStatuses]);

  const saveWorkerSettings = async () => {
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workerSettings),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save settings");
      }
      setInfo("Settings saved and synced to all workers.");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleAddCloudUrl = async () => {
    if (!newCloudUrl.trim()) return;
    setAdding(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/cloud-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: newCloudUrl.trim(), name: newCloudName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to add cloud URL");
      setNewCloudUrl("");
      setNewCloudName("");
      if (data?.initialSync?.ok) {
        setInfo("Cloud worker registered and initial sync completed.");
      } else if (data?.initialSync?.error) {
        setInfo(`Cloud worker registered, but initial sync failed: ${data.initialSync.error}`);
      } else {
        setInfo("Cloud worker registered.");
      }
      await loadSettings();
      await refreshAllStatuses(data.cloudUrls || undefined);
    } catch (e) {
      setError(e.message);
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteCloudUrl = async (id) => {
    if (!confirm("Remove this cloud worker? Your local providers stay; the worker's stored data is left as-is.")) {
      return;
    }

    try {
      const res = await fetch("/api/cloud-urls", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to delete cloud URL");
      await loadSettings();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleSyncNow = async (entryId = null) => {
    setSyncingId(entryId || "all");
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/cloud-urls/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entryId ? { id: entryId } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sync failed");
      setInfo(entryId ? "Worker synced." : `Synced to ${data.workersOk} worker(s).`);
      await loadSettings();
      await refreshAllStatuses();
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncingId(null);
    }
  };

  const handleOpenDashboard = async (id) => {
    try {
      const res = await fetch(`/api/cloud-urls/${id}/status`);
      const data = await res.json();
      if (data.dashboardUrl) {
        window.open(data.dashboardUrl, "_blank", "noopener,noreferrer");
      } else {
        setError(data.error || "Worker did not return a dashboard URL");
      }
    } catch (e) {
      setError(e.message);
    }
  };

  const handleRevealSecret = async (id) => {
    try {
      if (revealedSecrets[id]) {
        setRevealedSecrets((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        return;
      }

      setLoadingSecretId(id);
      const res = await fetch(`/api/cloud-urls/${id}/status?includeSecret=1`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load worker secret");
      if (!data.secret) throw new Error("Worker secret is unavailable");
      setRevealedSecrets((prev) => ({ ...prev, [id]: data.secret }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingSecretId(null);
    }
  };

  const handleCopySecret = async (entryId, fallbackMasked) => {
    const secret = revealedSecrets[entryId];
    if (secret) {
      copy(secret, entryId);
      return;
    }

    try {
      setLoadingSecretId(entryId);
      const res = await fetch(`/api/cloud-urls/${entryId}/status?includeSecret=1`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load worker secret");
      if (!data.secret) throw new Error("Worker secret is unavailable");
      setRevealedSecrets((prev) => ({ ...prev, [entryId]: data.secret }));
      copy(data.secret, entryId);
    } catch (e) {
      setError(e.message || `Failed to copy ${fallbackMasked || "secret"}`);
    } finally {
      setLoadingSecretId(null);
    }
  };

  const handleToggleR2Backup = async (enabled) => {
    setR2BackupEnabled(enabled);
    setR2Error("");
    setR2InfoMessage("");
    try {
      const res = await fetch("/api/r2", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ r2BackupEnabled: enabled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update R2 settings");
      }
      setR2InfoMessage(enabled ? "R2 auto-backup enabled." : "R2 auto-backup disabled.");
    } catch (e) {
      setR2Error(e.message);
      setR2BackupEnabled(!enabled);
    }
  };

  const handleR2ScheduleChange = async (schedule) => {
    setR2SqliteBackupSchedule(schedule);
    setR2Error("");
    setR2InfoMessage("");
    try {
      const res = await fetch("/api/r2", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ r2SqliteBackupSchedule: schedule }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update schedule");
      }
      setR2InfoMessage(`SQLite backup schedule set to ${schedule}.`);
    } catch (e) {
      setR2Error(e.message);
    }
  };

  const handleR2BackupNow = async () => {
    setR2Backing(true);
    setR2Error("");
    setR2InfoMessage("");
    try {
      const res = await fetch("/api/r2/backup", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Backup failed");
      setR2InfoMessage(`Backup completed: ${data.successes}/${data.total} workers.`);
      setR2LastBackupAt(new Date().toISOString());
    } catch (e) {
      setR2Error(e.message);
    } finally {
      setR2Backing(false);
    }
  };

  const handleLoadR2Info = async () => {
    setR2Loading(true);
    setR2Error("");
    try {
      const [infoRes, backupsRes] = await Promise.all([
        fetch("/api/r2/info"),
        fetch("/api/r2/restore"),
      ]);
      if (infoRes.ok) {
        const data = await infoRes.json();
        setR2Info(data);
      }
      if (backupsRes.ok) {
        const data = await backupsRes.json();
        setR2Backups(data.backups || []);
      }
    } catch (e) {
      setR2Error(e.message);
    } finally {
      setR2Loading(false);
    }
  };

  const handleR2Restore = async () => {
    if (!confirm("Restore will replace your current database with the latest R2 backup. A local backup will be created first. Continue?")) return;
    setR2Restoring(true);
    setR2Error("");
    setR2InfoMessage("");
    try {
      const res = await fetch("/api/r2/restore", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Restore failed");
      setR2InfoMessage(`Restored from ${data.restoredBackup}. Restart 9Router to apply changes.`);
    } catch (e) {
      setR2Error(e.message);
    } finally {
      setR2Restoring(false);
    }
  };

  return (
    <div className="space-y-6">
      <GlassCard>
        <SectionHeader
          title="Cloudflare Tunnel"
          subtitle="Expose your local 9Router instance via Cloudflare Tunnel"
          badge={<StatusBadge status={tunnelEnabled ? "Enabled" : "Disabled"} />}
        />
        <div className="mt-4 space-y-3">
          {tunnelEnabled && tunnelUrl && (
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
              <div className="mb-1 text-xs text-[var(--color-text-muted)]">Public URL</div>
              <div className="text-sm font-mono text-[var(--color-text-main)]">{tunnelUrl}</div>
            </div>
          )}
          <div className="text-xs text-[var(--color-text-muted)]">Manage tunnel settings in the Main tab</div>
        </div>
      </GlassCard>

      <GlassCard>
        <SectionHeader
          label="R2 STORAGE"
          title="R2 Backup & Restore"
          subtitle="Backup your 9Router data to Cloudflare R2 for disaster recovery and easy migration. All cloud workers share the same R2 bucket for provider data, usage, and SQLite backups."
          badge={<StatusBadge status={r2BackupEnabled ? "Enabled" : "Disabled"} />}
        />

        {(r2Error || r2InfoMessage) && (
          <div
            className="mt-4 rounded border p-3 text-xs"
            style={{
              borderColor: r2Error ? "#ef4444" : "#10b981",
              background: r2Error ? "#ef44441a" : "#10b9811a",
              color: r2Error ? "#fca5a5" : "#86efac",
            }}
          >
            {r2Error || r2InfoMessage}
          </div>
        )}

        <div className="mt-4 space-y-4">
          <ToggleRow
            label="Auto Backup"
            description="Automatically backup SQLite database and usage data to R2"
            checked={r2BackupEnabled}
            onChange={handleToggleR2Backup}
          />

          <div className="flex items-center gap-3">
            <label className="whitespace-nowrap text-xs text-[var(--color-text-muted)]">SQLite Backup Schedule</label>
            <div className="flex gap-1">
              {["daily", "weekly", "monthly"].map((schedule) => (
                <button
                  key={schedule}
                  onClick={() => handleR2ScheduleChange(schedule)}
                  className="rounded px-3 py-1 text-xs font-medium transition-colors"
                  style={{
                    background: r2SqliteBackupSchedule === schedule ? "var(--color-primary)" : "var(--color-bg-alt)",
                    color: r2SqliteBackupSchedule === schedule ? "#fff" : "var(--color-text-muted)",
                    border: `1px solid ${r2SqliteBackupSchedule === schedule ? "var(--color-primary)" : "var(--color-border)"}`,
                  }}
                >
                  {schedule.charAt(0).toUpperCase() + schedule.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {r2LastBackupAt && (
            <div className="text-xs text-[var(--color-text-muted)]">
              Last backup: {formatRelative(r2LastBackupAt)}
            </div>
          )}

          <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
            <Button size="sm" variant="secondary" onClick={handleR2BackupNow} disabled={r2Backing || cloudUrls.length === 0}>
              {r2Backing ? "Backing up…" : "Backup Now"}
            </Button>
            <Button size="sm" variant="secondary" onClick={handleLoadR2Info} disabled={r2Loading || cloudUrls.length === 0}>
              {r2Loading ? "Loading…" : "View R2 Status"}
            </Button>
            <Button
              size="sm"
              onClick={handleR2Restore}
              disabled={r2Restoring || cloudUrls.length === 0}
              className="bg-[var(--color-warning)] text-black hover:opacity-90"
            >
              {r2Restoring ? "Restoring…" : "Restore from R2"}
            </Button>
          </div>

          {cloudUrls.length === 0 && (
            <div className="text-xs text-[var(--color-text-muted)]">
              Add a cloud worker above to enable R2 backup/restore.
            </div>
          )}

          {r2Info && (
            <div className="mt-3 space-y-2">
              <div className="text-xs font-semibold text-[var(--color-text-main)]">R2 Storage Status</div>
              {r2Info.workers?.map((worker, index) => (
                <div key={index} className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--color-text-main)]">{worker.name}</span>
                    <StatusPill status={worker.status === "ok" ? "online" : "error"} />
                  </div>
                  <div className="mt-1 text-xs text-[var(--color-text-muted)]">{worker.url}</div>
                  {worker.status === "ok" && (
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)] sm:grid-cols-3">
                      <div>
                        <span className="opacity-70">Machines</span>
                        <div>{worker.machineCount ?? "—"}</div>
                      </div>
                      <div>
                        <span className="opacity-70">Backups</span>
                        <div>{worker.backupCount ?? "—"}</div>
                      </div>
                      <div>
                        <span className="opacity-70">Latest</span>
                        <div>{worker.latestBackup ? formatRelative(worker.latestBackup.uploaded) : "none"}</div>
                      </div>
                    </div>
                  )}
                  {worker.error && (
                    <div className="mt-1 text-xs" style={{ color: "#fca5a5" }}>{worker.error}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {r2Backups.length > 0 && (
            <div className="mt-3">
              <div className="mb-2 text-xs font-semibold text-[var(--color-text-main)]">Available Backups</div>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {r2Backups.map((backup, index) => (
                  <div key={index} className="flex items-center justify-between rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-xs">
                    <div>
                      <span className="font-mono text-[var(--color-text-main)]">{backup.key}</span>
                      <span className="ml-2 text-[var(--color-text-muted)]">
                        {backup.size ? `${(backup.size / 1024).toFixed(1)} KB` : ""}
                      </span>
                    </div>
                    <span className="text-[var(--color-text-muted)]">{formatRelative(backup.uploaded)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </GlassCard>

      <GlassCard>
        <SectionHeader
          title="Tailscale Funnel"
          subtitle="Expose your local 9Router instance via Tailscale Funnel"
          badge={<StatusBadge status={tsEnabled ? "Enabled" : "Disabled"} />}
        />
        <div className="mt-4 space-y-3">
          {tsEnabled && tsUrl && (
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
              <div className="mb-1 text-xs text-[var(--color-text-muted)]">Tailscale URL</div>
              <div className="text-sm font-mono text-[var(--color-text-main)]">{tsUrl}</div>
            </div>
          )}
          <div className="text-xs text-[var(--color-text-muted)]">Manage Tailscale settings in the Main tab</div>
        </div>
      </GlassCard>

      <GlassCard>
        <SectionHeader
          label="CLOUDFLARE WORKER"
          title="Cloud Workers"
          subtitle="Self-hosted Cloudflare Workers that run routing on the edge. Each worker is registered with a per-machine shared secret."
          badge={<StatusBadge status={cloudUrls.length > 0 ? `${cloudUrls.length} configured` : "None"} />}
        />

        {(error || info) && (
          <div
            className="mt-4 rounded border p-3 text-xs"
            style={{
              borderColor: error ? "#ef4444" : "#10b981",
              background: error ? "#ef44441a" : "#10b9811a",
              color: error ? "#fca5a5" : "#86efac",
            }}
          >
            {error || info}
          </div>
        )}

        <div className="mt-4 space-y-3">
          {cloudUrls.length === 0 ? (
            <div className="rounded border border-dashed border-[var(--color-border)] p-6 text-center">
              <div className="text-sm text-[var(--color-text-muted)]">
                No cloud workers configured yet. Deploy <code>cloud/</code> to Cloudflare Workers, then paste the URL below.
              </div>
            </div>
          ) : (
            cloudUrls.map((entry) => {
              const status = statusByUrl[entry.id];
              const probeStatus = status?.probe?.ok
                ? "online"
                : (status?.probe?.status || entry.status || "unknown");
              const workerError = status?.workerError || status?.error || null;
              const workerStatus = status?.workerStatus;
              const secretValue = revealedSecrets[entry.id] || status?.secretMasked || (entry.hasSecret ? "••••" : "Unavailable");
              const hasSecret = status?.hasSecret ?? entry.hasSecret;
              const isSecretLoading = loadingSecretId === entry.id;
              const workerMessage = getWorkerMessage(entry, workerError, workerStatus);
              const isSyncingThis = syncingId === entry.id;
              const isAnySyncing = syncingId !== null;

              return (
                <div
                  key={entry.id}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-[var(--color-text-main)]">
                          {entry.name || new URL(entry.url).hostname}
                        </span>
                        <StatusPill status={probeStatus} latencyMs={status?.probe?.latencyMs} />
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-[var(--color-text-muted)]">{entry.url}</div>
                      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-[var(--color-text-muted)] sm:grid-cols-4">
                        <div>
                          <span className="opacity-70">Last sync</span>
                          <div style={getLastSyncStyle(entry, workerStatus)}>{getLastSyncLabel(entry, workerStatus)}</div>
                        </div>
                        <div>
                          <span className="opacity-70">Providers</span>
                          <div>{workerStatus?.counts?.providers ?? entry.providersCount ?? "—"}</div>
                        </div>
                        <div>
                          <span className="opacity-70">Worker</span>
                          <div>v{workerStatus?.version || entry.version || "—"}</div>
                        </div>
                        <div>
                          <span className="opacity-70">Registered</span>
                          <div>{formatRelative(entry.registeredAt)}</div>
                        </div>
                      </div>
                      <div className="mt-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
                        <div className="mb-1 text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-muted)]">Worker Secret</div>
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="rounded bg-black/20 px-2 py-1 text-xs text-[var(--color-text-main)]">{secretValue}</code>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => handleRevealSecret(entry.id)}
                            disabled={!hasSecret || isSecretLoading}
                          >
                            {!hasSecret ? "Unavailable" : revealedSecrets[entry.id] ? "Hide" : (isSecretLoading ? "Loading…" : "Reveal")}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => handleCopySecret(entry.id, status?.secretMasked)}
                            disabled={!hasSecret || isSecretLoading}
                          >
                            {copied === entry.id ? "Copied" : "Copy"}
                          </Button>
                        </div>
                      </div>
                      {workerMessage && (
                        <div className="mt-2 text-xs" style={getWorkerMessageStyle(entry, workerError, workerStatus)}>
                          {workerMessage}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleSyncNow(entry.id)}
                        disabled={isAnySyncing || !entry.hasSecret}
                        title="Retry sync for this worker"
                      >
                        {isSyncingThis ? "Syncing…" : "Sync now"}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => handleOpenDashboard(entry.id)}>
                        Open Dashboard
                      </Button>
                      <button
                        onClick={() => handleDeleteCloudUrl(entry.id)}
                        title="Remove worker"
                        className="rounded p-1 text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/10"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}

          <div className="rounded border border-[var(--color-border)] p-3">
            <div className="mb-2 text-xs text-[var(--color-text-muted)]">Add a new cloud worker</div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={newCloudName}
                onChange={(e) => setNewCloudName(e.target.value)}
                placeholder="Name (optional, e.g. Production)"
                className="sm:w-1/3"
              />
              <Input
                value={newCloudUrl}
                onChange={(e) => setNewCloudUrl(e.target.value)}
                placeholder="https://your-worker.workers.dev"
                className="flex-1"
              />
              <Button variant="secondary" onClick={handleAddCloudUrl} disabled={adding}>
                {adding ? "Registering…" : "Add & Register"}
              </Button>
            </div>
            <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
              9Router probes <code>/admin/health</code>, generates a per-worker shared secret, registers the worker, then immediately attempts an initial sync.
            </div>
          </div>

          {cloudUrls.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
              <Button size="sm" variant="secondary" onClick={() => refreshAllStatuses()}>
                Refresh status
              </Button>
              <Button size="sm" onClick={() => handleSyncNow()} disabled={syncingId !== null} title="Sync all registered workers">
                {syncingId === "all" ? "Syncing…" : "Sync all"}
              </Button>
            </div>
          )}
        </div>
      </GlassCard>

      <GlassCard>
        <SectionHeader
          label="WORKER POLICY"
          title="Routing Settings"
          subtitle="Fine-tune how requests are distributed across credentials"
          badge={<StatusBadge status="Worker policy" />}
        />

        <div className="mt-6 space-y-4">
          <ToggleRow
            label="Round-Robin"
            description="Distribute requests across multiple credentials"
            checked={workerSettings.roundRobin}
            onChange={(checked) => setWorkerSettings((prev) => ({ ...prev, roundRobin: checked }))}
          />

          <ToggleRow
            label="Sticky Sessions"
            description="Maintain consistent routing per client"
            checked={workerSettings.sticky}
            onChange={(checked) => setWorkerSettings((prev) => ({ ...prev, sticky: checked }))}
          />

          {workerSettings.sticky && (
            <div className="pl-4">
              <Input
                label="Sticky Duration (seconds)"
                type="number"
                value={workerSettings.stickyDuration}
                onChange={(e) =>
                  setWorkerSettings((prev) => ({ ...prev, stickyDuration: parseInt(e.target.value, 10) }))
                }
                min={60}
                max={3600}
              />
              <div className="mt-2 text-xs text-[var(--color-text-muted)]">
                Defines how long a client stays pinned to the same credential
              </div>
            </div>
          )}

          <div className="flex justify-end pt-4">
            <Button
              onClick={saveWorkerSettings}
              disabled={saving}
              className="bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]"
            >
              {saving ? "Saving..." : "Save Settings"}
            </Button>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
