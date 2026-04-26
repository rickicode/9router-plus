"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button, Input } from "@/shared/components";
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
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsUrl, setTsUrl] = useState("");

  // R2 backup/restore state
  const [r2BackupEnabled, setR2BackupEnabled] = useState(false);
  const [r2Info, setR2Info] = useState(null);
  const [r2Backups, setR2Backups] = useState([]);
  const [r2Loading, setR2Loading] = useState(false);
  const [r2Backing, setR2Backing] = useState(false);
  const [r2Restoring, setR2Restoring] = useState(false);
  const [r2LastBackupAt, setR2LastBackupAt] = useState(null);
  const [r2Error, setR2Error] = useState("");
  const [r2Info2, setR2Info2] = useState("");

  const pollTimerRef = useRef(null);

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
    for (const r of results) {
      if (r.status === "fulfilled") {
        const [id, body, ok] = r.value;
        next[id] = ok ? body : { error: body?.error || "fetch failed" };
      }
    }
    setStatusByUrl(next);
  }, [cloudUrls]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSettings();
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [loadSettings]);

  // Poll every 30s while the tab is mounted to keep status fresh.
  const cloudIdsKey = cloudUrls.map((c) => c.id).join(",");
  useEffect(() => {
    if (!cloudIdsKey) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      setInfo("Cloud worker registered. Run 'Sync now' to push your providers.");
      await loadSettings();
    } catch (e) {
      setError(e.message);
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteCloudUrl = async (id) => {
    if (!confirm("Remove this cloud worker? Your local providers stay; the worker's stored data is left as-is.")) return;
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

  const handleSyncNow = async () => {
    setSyncing(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/cloud-urls/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sync failed");
      setInfo(`Synced to ${data.workersOk} worker(s).`);
      await refreshAllStatuses();
      await loadSettings();
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
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

  // R2 Backup/Restore handlers
  const handleToggleR2Backup = async (enabled) => {
    setR2BackupEnabled(enabled);
    setR2Error("");
    setR2Info2("");
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
      setR2Info2(enabled ? "R2 auto-backup enabled." : "R2 auto-backup disabled.");
    } catch (e) {
      setR2Error(e.message);
      setR2BackupEnabled(!enabled);
    }
  };

  const handleR2BackupNow = async () => {
    setR2Backing(true);
    setR2Error("");
    setR2Info2("");
    try {
      const res = await fetch("/api/r2/backup", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Backup failed");
      setR2Info2(`Backup completed: ${data.successes}/${data.total} workers.`);
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
    setR2Info2("");
    try {
      const res = await fetch("/api/r2/restore", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Restore failed");
      setR2Info2(`Restored from ${data.restoredBackup}. Restart 9Router to apply changes.`);
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
        <div className="space-y-3 mt-4">
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
          title="Tailscale Funnel"
          subtitle="Expose your local 9Router instance via Tailscale Funnel"
          badge={<StatusBadge status={tsEnabled ? "Enabled" : "Disabled"} />}
        />
        <div className="space-y-3 mt-4">
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
              const probeStatus = status?.probe?.ok ? "online" : (status?.probe?.status || entry.status || "unknown");
              const workerError = status?.workerError;
              const workerStatus = status?.workerStatus;
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
                          <div>{formatRelative(entry.lastSyncAt || workerStatus?.lastSyncAt)}</div>
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
                      {(entry.lastSyncError || workerError) && (
                        <div className="mt-2 text-xs" style={{ color: "#fca5a5" }}>
                          {entry.lastSyncError || workerError}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
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
              9Router probes <code>/admin/health</code>, generates a per-worker shared secret, then calls{" "}
              <code>POST /admin/register</code> on the worker before saving the URL locally.
            </div>
          </div>

          {cloudUrls.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
              <Button size="sm" variant="secondary" onClick={refreshAllStatuses}>
                Refresh status
              </Button>
              <Button size="sm" onClick={handleSyncNow} disabled={syncing}>
                {syncing ? "Syncing…" : "Sync now"}
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

        <div className="space-y-4 mt-6">
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

      <GlassCard>
        <SectionHeader
          label="R2 STORAGE"
          title="R2 Backup & Restore"
          subtitle="Backup your 9Router data to Cloudflare R2 for disaster recovery and easy migration. All cloud workers share the same R2 bucket for provider data, usage, and SQLite backups."
          badge={<StatusBadge status={r2BackupEnabled ? "Enabled" : "Disabled"} />}
        />

        {(r2Error || r2Info2) && (
          <div
            className="mt-4 rounded border p-3 text-xs"
            style={{
              borderColor: r2Error ? "#ef4444" : "#10b981",
              background: r2Error ? "#ef44441a" : "#10b9811a",
              color: r2Error ? "#fca5a5" : "#86efac",
            }}
          >
            {r2Error || r2Info2}
          </div>
        )}

        <div className="space-y-4 mt-4">
          <ToggleRow
            label="Auto Backup"
            description="Automatically backup SQLite database and usage data to R2 every 6 hours"
            checked={r2BackupEnabled}
            onChange={handleToggleR2Backup}
          />

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
              {r2Info.workers?.map((w, i) => (
                <div key={i} className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-[var(--color-text-main)]">{w.name}</span>
                    <StatusPill status={w.status === "ok" ? "online" : "error"} />
                  </div>
                  <div className="mt-1 text-xs text-[var(--color-text-muted)]">{w.url}</div>
                  {w.status === "ok" && (
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)] sm:grid-cols-3">
                      <div>
                        <span className="opacity-70">Machines</span>
                        <div>{w.machineCount ?? "—"}</div>
                      </div>
                      <div>
                        <span className="opacity-70">Backups</span>
                        <div>{w.backupCount ?? "—"}</div>
                      </div>
                      <div>
                        <span className="opacity-70">Latest</span>
                        <div>{w.latestBackup ? formatRelative(w.latestBackup.uploaded) : "none"}</div>
                      </div>
                    </div>
                  )}
                  {w.error && (
                    <div className="mt-1 text-xs" style={{ color: "#fca5a5" }}>{w.error}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {r2Backups.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold text-[var(--color-text-main)] mb-2">Available Backups</div>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {r2Backups.map((b, i) => (
                  <div key={i} className="flex items-center justify-between rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-xs">
                    <div>
                      <span className="font-mono text-[var(--color-text-main)]">{b.key}</span>
                      <span className="ml-2 text-[var(--color-text-muted)]">
                        {b.size ? `${(b.size / 1024).toFixed(1)} KB` : ""}
                      </span>
                    </div>
                    <span className="text-[var(--color-text-muted)]">{formatRelative(b.uploaded)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </GlassCard>
    </div>
  );
}
