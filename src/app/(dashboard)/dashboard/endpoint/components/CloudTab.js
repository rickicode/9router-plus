"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import GlassCard from "./shared/GlassCard";
import StatusBadge from "./shared/StatusBadge";
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
  const router = useRouter();
  const [cloudUrls, setCloudUrls] = useState([]);
  const [statusByUrl, setStatusByUrl] = useState({});
  const [newCloudUrl, setNewCloudUrl] = useState("");
  const [newCloudName, setNewCloudName] = useState("");
  const [adding, setAdding] = useState(false);
  const [syncingId, setSyncingId] = useState(null);
  const [revealedSecrets, setRevealedSecrets] = useState({});
  const [loadingSecretId, setLoadingSecretId] = useState(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsUrl, setTsUrl] = useState("");

  const pollTimerRef = useRef(null);
  const { copied, copy } = useCopyToClipboard();

  const loadSettings = useCallback(async () => {
    try {
      const [tunnelRes, cloudUrlsRes] = await Promise.all([
        fetch("/api/tunnel/status"),
        fetch("/api/cloud-urls"),
      ]);

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
          title="R2 Storage"
          subtitle="Connection details, backup schedule, and restore controls now live in Settings."
          badge={<StatusBadge status="Managed in Settings" />}
        />

        <div className="mt-4 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="text-sm font-medium text-[var(--color-text-main)]">
                R2 Storage is managed in Settings.
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">
                Open Settings to manage connection details, backup schedule, manual backups, and restore.
              </div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => router.push("/dashboard/settings")}>
              Open Settings
            </Button>
          </div>
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
          subtitle="Self-hosted Cloudflare Workers that execute the latest synced config from Settings. Each worker is registered with a per-machine shared secret."
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

          <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="text-sm font-medium text-[var(--color-text-main)]">
                  Routing behavior is managed in Settings.
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  Round-robin, sticky sessions, and sticky duration live in one place and sync to every worker automatically.
                </div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => router.push("/dashboard/settings")}>
                Open Settings
              </Button>
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
    </div>
  );
}
