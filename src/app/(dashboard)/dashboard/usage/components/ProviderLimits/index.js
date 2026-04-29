"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import ProviderIcon from "@/shared/components/ProviderIcon";
import QuotaTable from "./QuotaTable";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import Pagination from "@/shared/components/Pagination";
import Toggle from "@/shared/components/Toggle";
import { EditConnectionModal } from "@/shared/components";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { useUrlQueryControls } from "@/shared/hooks";
import {
  getConnectionCentralizedStatus,
  getConnectionFilterStatus,
  normalizeConnectionFilterStatus,
} from "@/lib/connectionStatus";
import { getStoredQuotaPresentation } from "./utils";

const DEFAULT_PAGE_SIZE = 24;
const STATUS_POLL_INTERVAL_MS = 15000;

function getSupportedOAuthConnections(connections = []) {
  return connections.filter(
    (conn) => USAGE_SUPPORTED_PROVIDERS.includes(conn.provider) && conn.authType === "oauth",
  );
}

function filterVisibleConnections(connections = [], searchQuery = "", statusFilter = "all") {
  const query = searchQuery.trim().toLowerCase();

  return connections.filter((conn) => {
    const status = getConnectionFilterStatus(conn);
    const matchesSearch = !query || [conn.provider, conn.name, conn.displayName, conn.email, conn.connectionName, conn.id]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
    const matchesStatus = statusFilter === "all" || status === statusFilter;

    return matchesSearch && matchesStatus;
  });
}

function sortConnectionsByProvider(connections = []) {
  return [...connections].sort((a, b) => {
    const orderA = USAGE_SUPPORTED_PROVIDERS.indexOf(a.provider);
    const orderB = USAGE_SUPPORTED_PROVIDERS.indexOf(b.provider);
    if (orderA !== orderB) return orderA - orderB;
    return a.provider.localeCompare(b.provider);
  });
}

function getCanonicalStatusCounts(connections = []) {
  return connections.reduce((counts, connection) => {
    const status = getConnectionCentralizedStatus(connection);

    switch (status) {
      case "eligible":
      case "exhausted":
      case "blocked":
      case "unknown":
      case "disabled":
        counts[status] += 1;
        break;
      default:
        counts.unknown += 1;
        break;
    }

    return counts;
  }, {
    eligible: 0,
    exhausted: 0,
    blocked: 0,
    unknown: 0,
    disabled: 0,
  });
}

function getRelativeTime(dateString) {
  if (!dateString) return "Never";

  const timestamp = new Date(dateString).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMinutes > 0) return `${diffMinutes}m ago`;
  return "Just now";
}

function getSchedulerTone(status, enabled) {
  if (!enabled) {
    return {
      icon: "pause_circle",
      label: "Scheduler paused",
      tone: "text-text-muted",
      surface: "border-border bg-surface",
    };
  }

  switch (status) {
    case "running":
      return {
        icon: "progress_activity",
        label: "Sweep running",
        tone: "text-[var(--color-primary)]",
        surface: "border-[var(--color-primary-border)] bg-[var(--color-primary-soft)]",
      };
    case "cancelling":
      return {
        icon: "sync",
        label: "Restarting sweep",
        tone: "text-[var(--color-warning)]",
        surface: "border-[var(--color-warning-border)] bg-[var(--color-warning-soft)]",
      };
    case "error":
      return {
        icon: "error",
        label: "Scheduler error",
        tone: "text-[var(--color-danger)]",
        surface: "border-[var(--color-danger-border)] bg-[var(--color-danger-soft)]",
      };
    default:
      return {
        icon: "schedule",
        label: "Watching shared state",
        tone: "text-[var(--color-success)]",
        surface: "border-[var(--color-success-border)] bg-[var(--color-success-soft)]",
      };
  }
}

function getSchedulerMessage(status = {}) {
  if (!status) return "Shared quota state is loaded from the backend scheduler.";

  if (!status.enabled) {
    return "Automatic quota sweeps are disabled. Stored state remains visible until the scheduler is re-enabled.";
  }

  if (status.status === "running") {
    const rangeStart = status?.currentRun?.progress?.currentBatchStart ?? status?.progress?.currentBatchStart;
    const rangeEnd = status?.currentRun?.progress?.currentBatchEnd ?? status?.progress?.currentBatchEnd;
    if (Number.isFinite(rangeStart) && Number.isFinite(rangeEnd)) {
      return `Backend sweep sedang cek ${rangeStart} sampai ${rangeEnd}.`;
    }

    return "Backend sweep is updating shared quota state now. Cards will reflect changes on the next lightweight status refresh.";
  }

  if (status.status === "cancelling" || status.restartRequested) {
    return "A manual refresh requested a restart. The backend will cancel the current sweep and begin a fresh one.";
  }

  if (status.status === "error") {
    return status.error?.message || "The last scheduler run failed. Stored state is still shown while the backend recovers.";
  }

  if (status.lastRun?.finishedAt) {
    return `Last backend sweep completed ${getRelativeTime(status.lastRun.finishedAt)}.`;
  }

  return "Quota cards show the latest backend-maintained shared state without browser fan-out polling.";
}

export default function ProviderLimits() {
  const router = useRouter();
  const {
    getQueryValue,
    updateQueryParams,
  } = useUrlQueryControls({
    fallbackPath: "/dashboard/quota",
    normalizers: {
      statusFilter: (value) => {
        const normalizedValue = normalizeConnectionFilterStatus(value || "all");
        return normalizedValue === "all" ? "" : normalizedValue;
      },
    },
  });
  const [connections, setConnections] = useState([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [schedulerStatus, setSchedulerStatus] = useState(null);
  const [schedulerStatusLoading, setSchedulerStatusLoading] = useState(true);
  const [schedulerStatusError, setSchedulerStatusError] = useState("");
  const [refreshActionError, setRefreshActionError] = useState("");
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingConnectionIds, setRefreshingConnectionIds] = useState({});
  const [connectionRefreshErrors, setConnectionRefreshErrors] = useState({});
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const searchQuery = getQueryValue("searchQuery", "");
  const statusFilter = getQueryValue("statusFilter", "all") || "all";

  const fetchConnections = useCallback(async () => {
    const response = await fetch("/api/providers/client", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to fetch connections");

    const data = await response.json();
    const connectionList = data.connections || [];
    setConnections(connectionList);
    return connectionList;
  }, []);

  const fetchSchedulerStatus = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setSchedulerStatusLoading(true);
    }

    try {
      const response = await fetch("/api/quota-refresh/status", { cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load scheduler status");
      }

      const data = await response.json();
      setSchedulerStatus(data);
      setSchedulerStatusError("");
      return data;
    } catch (error) {
      console.error("Error fetching scheduler status:", error);
      setSchedulerStatusError(error.message || "Failed to load scheduler status");
      return null;
    } finally {
      if (!silent) {
        setSchedulerStatusLoading(false);
      }
    }
  }, []);

  const refreshSharedState = useCallback(async ({ silentStatus = false } = {}) => {
    try {
      await fetchConnections();
    } catch (error) {
      console.error("Error fetching connections:", error);
      setConnections([]);
    }

    await fetchSchedulerStatus({ silent: silentStatus });
  }, [fetchConnections, fetchSchedulerStatus]);

  useEffect(() => {
    const initializeData = async () => {
      setConnectionsLoading(true);
      await refreshSharedState();
      setConnectionsLoading(false);
    };

    initializeData();
  }, [refreshSharedState]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      refreshSharedState({ silentStatus: true }).catch(() => {});
    }, STATUS_POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [refreshSharedState]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.proxyPools) {
          setProxyPools(data.proxyPools);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDeleteConnection = useCallback(async (id) => {
    if (!confirm("Delete this connection?")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
      if (res.ok) {
        setConnections((prev) => prev.filter((c) => c.id !== id));
      }
    } catch (error) {
      console.error("Error deleting connection:", error);
    } finally {
      setDeletingId(null);
    }
  }, []);

  const handleToggleConnectionActive = useCallback(async (id, isActive) => {
    setTogglingId(id);
    try {
      const res = await fetch(`/api/providers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setConnections((prev) =>
          prev.map((c) => (c.id === id ? { ...c, isActive } : c)),
        );
      }
    } catch (error) {
      console.error("Error updating connection status:", error);
    } finally {
      setTogglingId(null);
    }
  }, []);

  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return;
      const connectionId = selectedConnection.id;

      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });

        if (res.ok) {
          await fetchConnections();
          setShowEditModal(false);
          setSelectedConnection(null);
        }
      } catch (error) {
        console.error("Error saving connection:", error);
      }
    },
    [fetchConnections, selectedConnection],
  );

  const refreshAll = useCallback(async () => {
    setRefreshingAll(true);
    setRefreshActionError("");

    try {
      const response = await fetch("/api/quota-refresh/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "dashboard_manual_refresh" }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || data.reason || "Failed to request backend refresh");
      }

      if (data?.snapshot) {
        setSchedulerStatus(data.snapshot);
        setSchedulerStatusError("");
      }

      await refreshSharedState({ silentStatus: true });
    } catch (error) {
      console.error("Error requesting backend refresh:", error);
      setRefreshActionError(error.message || "Failed to request backend refresh");
    } finally {
      setRefreshingAll(false);
    }
  }, [refreshSharedState]);

  const refreshConnectionUsage = useCallback(async (connectionId) => {
    if (!connectionId) return;

    setRefreshingConnectionIds((prev) => ({
      ...prev,
      [connectionId]: true,
    }));
    setConnectionRefreshErrors((prev) => {
      if (!prev[connectionId]) return prev;

      const next = { ...prev };
      delete next[connectionId];
      return next;
    });

    try {
      const response = await fetch(`/api/usage/${connectionId}`, {
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Failed to refresh usage");
      }

      await refreshSharedState({ silentStatus: true });
    } catch (error) {
      console.error(`Error refreshing usage for connection ${connectionId}:`, error);
      setConnectionRefreshErrors((prev) => ({
        ...prev,
        [connectionId]: error.message || "Failed to refresh usage",
      }));
    } finally {
      setRefreshingConnectionIds((prev) => {
        const next = { ...prev };
        delete next[connectionId];
        return next;
      });
    }
  }, [refreshSharedState]);

  const supportedConnections = useMemo(
    () => getSupportedOAuthConnections(connections),
    [connections],
  );

  const searchMatchedConnections = useMemo(
    () => filterVisibleConnections(supportedConnections, searchQuery, "all"),
    [searchQuery, supportedConnections],
  );

  const visibleConnections = useMemo(
    () => filterVisibleConnections(searchMatchedConnections, "", statusFilter),
    [searchMatchedConnections, statusFilter],
  );

  const sortedConnections = useMemo(
    () => sortConnectionsByProvider(visibleConnections),
    [visibleConnections],
  );

  const totalPages = Math.max(1, Math.ceil(sortedConnections.length / DEFAULT_PAGE_SIZE));
  const currentPageSafe = Math.min(currentPage, totalPages);
  const paginatedConnections = sortedConnections.slice(
    (currentPageSafe - 1) * DEFAULT_PAGE_SIZE,
    currentPageSafe * DEFAULT_PAGE_SIZE,
  );

  const quotaCards = useMemo(
    () => supportedConnections.map((conn) => ({
      connection: conn,
      quota: getStoredQuotaPresentation(conn),
    })),
    [supportedConnections],
  );

  const visibleQuotaCards = useMemo(() => {
    const quotaCardsById = new Map(quotaCards.map((card) => [card.connection.id, card]));

    return visibleConnections
      .map((connection) => quotaCardsById.get(connection.id))
      .filter(Boolean);
  }, [quotaCards, visibleConnections]);

  const activeWithLimits = visibleQuotaCards.filter(
    ({ quota }) => quota.quotas.length > 0,
  ).length;

  const canonicalStatusCounts = useMemo(
    () => getCanonicalStatusCounts(searchMatchedConnections),
    [searchMatchedConnections],
  );

  const schedulerTone = getSchedulerTone(schedulerStatus?.status, schedulerStatus?.enabled);
  const schedulerMessage = getSchedulerMessage(schedulerStatus);
  const schedulerLastUpdated = schedulerStatus?.lastRun?.finishedAt
    || schedulerStatus?.currentRun?.startedAt
    || schedulerStatus?.nextScheduledAt
    || null;
  const refreshButtonLabel = schedulerStatus?.status === "running"
    ? "Restart Sweep"
    : schedulerStatus?.restartRequested
      ? "Restart Requested"
      : "Refresh All";

  if (!connectionsLoading && supportedConnections.length === 0) {
    return (
      <Card padding="lg">
        <div className="text-center py-12">
          <span className="material-symbols-outlined text-[64px] text-text-muted opacity-20">
            cloud_off
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-main">
            No Providers Connected
          </h3>
          <p className="mt-2 text-sm text-text-muted max-w-md mx-auto">
            Connect to providers with OAuth to observe backend-maintained API quota state.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded border border-border bg-surface px-4 py-4 space-y-4">
        <div className="space-y-3">
          <div>
            <h2 className="text-xl font-semibold text-text-main">
              Provider Limits
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Read-only observer of backend-maintained shared quota state.
            </p>
          </div>

          <div className="space-y-2 text-xs text-text-muted">
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-1">
                {sortedConnections.length} matching {sortedConnections.length === 1 ? "connection" : "connections"}
              </span>
              <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-1">
                {activeWithLimits} with quota data
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <span className="inline-flex items-center rounded-full border border-[var(--color-success-border)] bg-[var(--color-success-soft)] px-2.5 py-1 text-[var(--color-success)]">
                {canonicalStatusCounts.eligible} eligible
              </span>
              <span className="inline-flex items-center rounded-full border border-[var(--color-warning-border)] bg-[var(--color-warning-soft)] px-2.5 py-1 text-[var(--color-warning)]">
                {canonicalStatusCounts.exhausted} exhausted
              </span>
              <span className="inline-flex items-center rounded-full border border-[var(--color-danger-border)] bg-[var(--color-danger-soft)] px-2.5 py-1 text-[var(--color-danger)]">
                {canonicalStatusCounts.blocked} blocked
              </span>
              <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-1">
                {canonicalStatusCounts.disabled} disabled
              </span>
              <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-1">
                {canonicalStatusCounts.unknown} unknown
              </span>
            </div>
          </div>

          <div className={`flex w-full items-start gap-3 rounded border px-3 py-3 ${schedulerTone.surface}`}>
            <span className={`material-symbols-outlined text-[18px] shrink-0 mt-0.5 ${schedulerTone.tone} ${schedulerStatus?.status === "running" ? "animate-spin" : schedulerStatus?.restartRequested ? "animate-pulse" : ""}`}>
              {schedulerTone.icon}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={`text-sm font-medium ${schedulerTone.tone}`}>
                  {schedulerTone.label}
                </span>
                {schedulerLastUpdated && (
                  <span className="text-xs text-text-muted">
                    updated {getRelativeTime(schedulerLastUpdated)}
                  </span>
                )}
              </div>
              <p className="text-xs leading-5 text-text-muted">
                {schedulerMessage}
              </p>
              {(schedulerStatus?.nextScheduledAt || schedulerStatus?.currentRun?.trigger) && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
                  {schedulerStatus?.currentRun?.trigger && (
                    <span>Trigger: {schedulerStatus.currentRun.trigger}</span>
                  )}
                  {schedulerStatus?.nextScheduledAt && (
                    <span>Next sweep {getRelativeTime(schedulerStatus.nextScheduledAt)}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_auto] lg:items-end">
          <Input
            key={`quota-search-${searchQuery}`}
            label="Search accounts"
            icon="search"
            defaultValue={searchQuery}
            onChange={(e) => {
              const value = e.target.value;
              setCurrentPage(1);
              updateQueryParams({ searchQuery: value.trim() ? value : null });
            }}
            placeholder="Search by name, provider, email, or id"
            className="min-w-0"
          />

          <Select
            key={`quota-status-${statusFilter}`}
            label="Status"
            defaultValue={statusFilter}
            onChange={(e) => {
              const nextValue = normalizeConnectionFilterStatus(e.target.value);
              setCurrentPage(1);
              updateQueryParams({ statusFilter: nextValue === "all" ? null : nextValue });
            }}
            placeholder="All"
            options={[
              { value: "all", label: "All" },
              { value: "eligible", label: "Eligible" },
              { value: "exhausted", label: "Exhausted" },
              { value: "blocked", label: "Blocked" },
              { value: "disabled", label: "Disabled" },
              { value: "unknown", label: "Unknown" },
            ]}
            className="min-w-0"
          />

          <Button
            variant="secondary"
            size="md"
            icon={schedulerStatus?.status === "running" ? "sync" : "refresh"}
            onClick={refreshAll}
            disabled={refreshingAll}
            loading={refreshingAll}
            className="w-full lg:w-auto"
            title="Request backend quota refresh sweep"
          >
            {refreshButtonLabel}
          </Button>
        </div>

        {(schedulerStatusError || refreshActionError) && (
          <div className="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">
            {refreshActionError || schedulerStatusError}
          </div>
        )}

        {schedulerStatusLoading && !schedulerStatus && (
          <div className="rounded border border-border bg-surface px-3 py-2 text-xs text-text-muted">
            Loading scheduler status…
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {paginatedConnections.map((conn) => {
          const quota = getStoredQuotaPresentation(conn);
          const isInactive = conn.isActive === false;
          const rowBusy = deletingId === conn.id || togglingId === conn.id;
          const isRefreshingConnection = Boolean(refreshingConnectionIds[conn.id]);
          const connectionRefreshError = connectionRefreshErrors[conn.id] || "";

          return (
            <Card
              key={conn.id}
              padding="none"
              className={`min-w-0 ${isInactive ? "opacity-60" : ""}`}
            >
              <div className="px-4 py-3 border-b border-border">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-8 h-8 shrink-0 rounded flex items-center justify-center overflow-hidden">
                      <ProviderIcon
                        src={`/providers/${conn.provider}.png`}
                        alt={conn.provider}
                        size={32}
                        className="object-contain"
                        fallbackText={conn.provider?.slice(0, 2).toUpperCase() || "PR"}
                      />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-text-main capitalize truncate">
                        {conn.provider}
                      </h3>
                      {conn.name && (
                        <p className="text-xs text-text-muted truncate">
                          {conn.name}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <div
                      className="inline-flex items-center rounded border border-border bg-surface px-2 py-1 text-[11px] text-text-muted"
                      title="Current provider account status"
                    >
                      {getConnectionCentralizedStatus(conn)}
                    </div>
                    <button
                      type="button"
                      onClick={() => refreshConnectionUsage(conn.id)}
                      disabled={rowBusy || isRefreshingConnection}
                      className="p-1.5 rounded hover:bg-bg-subtle text-text-muted hover:text-[var(--color-primary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Refresh quota"
                    >
                      <span
                        className={`material-symbols-outlined text-[18px] ${isRefreshingConnection ? "animate-spin" : ""}`}
                      >
                        refresh
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedConnection(conn);
                        setShowEditModal(true);
                      }}
                      disabled={rowBusy}
                      className="p-1.5 rounded hover:bg-bg-subtle text-text-muted hover:text-[var(--color-primary)] transition-colors disabled:opacity-50"
                      title="Edit connection"
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        edit
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteConnection(conn.id)}
                      disabled={rowBusy}
                      className="p-1.5 rounded hover:bg-[var(--color-danger-soft)] text-[var(--color-danger)] transition-colors disabled:opacity-50"
                      title="Delete connection"
                    >
                      <span
                        className={`material-symbols-outlined text-[18px] ${deletingId === conn.id ? "animate-pulse" : ""}`}
                      >
                        delete
                      </span>
                    </button>
                    <div
                      className="inline-flex items-center pl-0.5"
                      title={(conn.isActive ?? true) ? "Disable connection" : "Enable connection"}
                    >
                      <Toggle
                        size="sm"
                        checked={conn.isActive ?? true}
                        disabled={rowBusy}
                        onChange={(nextActive) => handleToggleConnectionActive(conn.id, nextActive)}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="px-3 py-3">
                {connectionRefreshError && (
                  <div className="mb-3 rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">
                    {connectionRefreshError}
                  </div>
                )}
                {quota.message ? (
                  <div className="rounded border border-[var(--color-warning-border)] bg-[var(--color-warning-soft)] px-3 py-3 text-xs text-text-muted">
                    {quota.message}
                  </div>
                ) : quota.quotas?.length > 0 ? (
                  <QuotaTable quotas={quota.quotas} compact />
                ) : (
                  <div className="rounded border border-dashed border-border bg-surface/70 px-3 py-4 text-center">
                    <p className="text-xs font-medium text-text-main">Waiting for backend quota snapshot</p>
                    <p className="mt-1 text-xs text-text-muted">
                      Use the reload icon to refresh just this account, or Refresh All to request a backend sweep.
                    </p>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {sortedConnections.length > 0 && (
        <Pagination
          currentPage={currentPageSafe}
          pageSize={DEFAULT_PAGE_SIZE}
          totalItems={sortedConnections.length}
          onPageChange={(page) => setCurrentPage(Math.max(1, Math.min(page, totalPages)))}
        />
      )}

      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => {
          setShowEditModal(false);
          setSelectedConnection(null);
        }}
      />
    </div>
  );
}
