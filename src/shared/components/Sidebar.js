"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import {
  DASHBOARD_DEBUG_NAV_ITEMS,
  DASHBOARD_MEDIA_PROVIDERS_NAV_ITEM,
  DASHBOARD_PRIMARY_NAV_ITEMS,
  DASHBOARD_SETTINGS_NAV_ITEM,
  DASHBOARD_SYSTEM_NAV_ITEMS,
  isDashboardMediaKindActive,
  isDashboardNavItemActive,
} from "@/shared/constants/dashboardNavigation";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import Button from "./Button";
import { ConfirmModal } from "./Modal";

// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["embedding", "image", "tts"];

const ROUTING_PROBE_INTERVAL_MS = 15000;
const ROUTING_PROBE_TIMEOUT_MS = 4000;

export default function Sidebar({ onClose }) {
  const pathname = usePathname();
  const [mediaOpen, setMediaOpen] = useState(false);
  const [showShutdownModal, setShowShutdownModal] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [enableTranslator, setEnableTranslator] = useState(false);
  const [routingLatency, setRoutingLatency] = useState(null);
  const { copied, copy } = useCopyToClipboard(2000);

  const INSTALL_CMD = UPDATER_CONFIG.installCmd;

  useEffect(() => {
    Promise.all([
      fetch("/api/settings").then(res => res.json()),
      fetch("/api/version").then(res => res.json()),
    ])
      .then(([settingsData, versionData]) => {
        if (settingsData.enableTranslator) setEnableTranslator(true);

        if (versionData.hasUpdate) setUpdateInfo(versionData);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;

    const probeLatency = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ROUTING_PROBE_TIMEOUT_MS);
      const startedAt = performance.now();

      try {
        const response = await fetch("/api/health", {
          cache: "no-store",
          signal: controller.signal,
        });

        const elapsedMs = performance.now() - startedAt;

        if (cancelled) return;

        setRoutingLatency({
          count: 1,
          p50: elapsedMs,
          p95: elapsedMs,
          lastMs: elapsedMs,
          errorCount: response.ok ? 0 : 1,
          status: response.ok ? "ok" : "error",
        });
      } catch {
        if (cancelled) return;

        setRoutingLatency({
          count: 1,
          p50: null,
          p95: null,
          lastMs: null,
          errorCount: 1,
          status: "error",
        });
      } finally {
        clearTimeout(timeoutId);
      }
    };

    probeLatency();
    const intervalId = setInterval(probeLatency, ROUTING_PROBE_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  const isActive = (href) => isDashboardNavItemActive(pathname, href);

  const routingStatus = (() => {
    if (!routingLatency) {
      return {
        label: "API Routing",
        detail: "Measuring…",
        className: "border-[var(--color-text-muted)]/30 text-[var(--color-text-muted)]",
        dotClassName: "bg-[var(--color-text-muted)]",
      };
    }

    const formatMs = (value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      if (value < 10) return `${value.toFixed(1)} ms`;
      return `${Math.round(value)} ms`;
    };

    const { count, p50, p95, lastMs, errorCount, status } = routingLatency;
    const sampleCount = typeof count === "number" ? count : 0;

    if (status === "error") {
      return {
        label: "API Routing",
        detail: "Health check failed",
        className: "border-[var(--color-danger)]/30 text-[var(--color-danger)]",
        dotClassName: "bg-[var(--color-danger)]",
      };
    }

    if (!sampleCount) {
      if (typeof lastMs === "number" && Number.isFinite(lastMs)) {
        return {
          label: `API ${formatMs(lastMs)}`,
          detail: "Last response",
          className: "border-[var(--color-text-muted)]/30 text-[var(--color-text-muted)]",
          dotClassName: "bg-[var(--color-text-muted)]",
        };
      }

      return {
        label: "API Routing",
        detail: "Awaiting response",
        className: "border-[var(--color-text-muted)]/30 text-[var(--color-text-muted)]",
        dotClassName: "bg-[var(--color-text-muted)]",
      };
    }

    const headline = formatMs(p50 ?? lastMs);
    const detail = formatMs(p50 ?? lastMs);

    let cls = "border-[var(--color-success)]/30 text-[var(--color-success)]";
    let dot = "bg-[var(--color-success)]";
    let statusLabel = "Healthy";

    if ((p95 ?? p50 ?? 0) > 500) {
      cls = "border-[var(--color-warning)]/30 text-[var(--color-warning)]";
      dot = "bg-[var(--color-warning)]";
      statusLabel = "Slow";
    }
    if ((p95 ?? p50 ?? 0) > 2000 || (errorCount && errorCount > sampleCount * 0.1)) {
      cls = "border-[var(--color-danger)]/30 text-[var(--color-danger)]";
      dot = "bg-[var(--color-danger)]";
      statusLabel = "Degraded";
    }

    return {
      label: statusLabel,
      detail,
      className: cls,
      dotClassName: dot,
    };
  })();

  const handleUpdate = async () => {
    setIsUpdating(true);
    setShowUpdateModal(false);
    try {
      const res = await fetch("/api/version/update", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.message || "Update failed. Please run the install command manually.");
        setIsUpdating(false);
        return;
      }
      // Server will exit shortly; show disconnected overlay
      setIsDisconnected(true);
    } catch (e) {
      // Expected once the server exits; treat as disconnected
      setIsDisconnected(true);
    }
  };

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/shutdown", { method: "POST" });
    } catch (e) {
      // Expected to fail as server shuts down; ignore error
    }
    setIsShuttingDown(false);
    setShowShutdownModal(false);
    setIsDisconnected(true);
  };

  return (
    <>
      <aside className="flex min-h-full w-72 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] transition-colors duration-300">
        {/* Logo */}
        <div className="px-6 py-4 flex flex-col gap-2">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="flex items-center justify-center size-9 rounded bg-[var(--color-primary)]">
              <span className="material-symbols-outlined text-[var(--color-text-inverse)] text-[20px]">hub</span>
            </div>
            <div className="flex flex-col">
              <h1 className="text-lg font-semibold tracking-tight text-[var(--color-text-main)]">
                {APP_CONFIG.name}
              </h1>
              <span className="text-xs text-[var(--color-text-muted)]">v{APP_CONFIG.version}</span>
            </div>
          </Link>
          {updateInfo && (
            <div className="flex flex-col gap-1.5 rounded p-1 -m-1">
              <span className="text-xs font-semibold text-[var(--color-success)]">
                ↑ New version available: v{updateInfo.latestVersion}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowUpdateModal(true)}
                  className="cursor-pointer rounded bg-[var(--color-success)] px-2 py-1 text-[11px] font-semibold text-[var(--color-text-inverse)] transition-colors hover:bg-[var(--color-success)]/90"
                >
                  Update now
                </button>
                <button
                  onClick={() => copy(INSTALL_CMD)}
                  title="Copy install command"
                  className="flex-1 text-left hover:opacity-80 transition-opacity cursor-pointer min-w-0"
                >
                  <code className="block truncate font-mono text-[10px] text-[var(--color-success)]/80">
                    {copied ? "✓ copied!" : INSTALL_CMD}
                  </code>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 py-2 space-y-1 overflow-y-auto custom-scrollbar">
          {DASHBOARD_PRIMARY_NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={cn(
                "group flex items-center gap-3 rounded px-4 py-2 transition-all",
                isActive(item.href)
                  ? "bg-[var(--color-primary)]/10 text-[var(--color-accent)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-text-main)]"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px]",
                  isActive(item.href) ? "fill-1" : "transition-colors group-hover:text-[var(--color-accent)]"
                )}
              >
                {item.icon}
              </span>
              <span className="text-sm font-medium">{item.label}</span>
            </Link>
          ))}

          {/* System section */}
          <div className="pt-4 mt-2">
            <p className="mb-2 px-4 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]/60">
              System
            </p>

            {/* Media Providers accordion */}
            <button
              onClick={() => setMediaOpen((v) => !v)}
              className={cn(
                "group flex w-full items-center gap-3 rounded px-4 py-2 transition-all",
                isActive(DASHBOARD_MEDIA_PROVIDERS_NAV_ITEM.href)
                  ? "bg-[var(--color-primary)]/10 text-[var(--color-accent)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-text-main)]"
              )}
            >
              <span className="material-symbols-outlined text-[18px]">{DASHBOARD_MEDIA_PROVIDERS_NAV_ITEM.icon}</span>
              <span className="text-sm font-medium flex-1 text-left">{DASHBOARD_MEDIA_PROVIDERS_NAV_ITEM.label}</span>
              <span className="material-symbols-outlined text-[14px] transition-transform" style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
                expand_more
              </span>
            </button>
            {mediaOpen && (
              <div className="pl-4">
                {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                  <Link
                    key={kind.id}
                    href={`/dashboard/media-providers/${kind.id}`}
                    onClick={onClose}
                    className={cn(
                      "group flex items-center gap-3 rounded px-4 py-1.5 transition-all",
                      isDashboardMediaKindActive(pathname, kind.id)
                        ? "bg-[var(--color-primary)]/10 text-[var(--color-accent)]"
                        : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-text-main)]"
                    )}
                  >
                    <span className="material-symbols-outlined text-[16px]">{kind.icon}</span>
                    <span className="text-sm">{kind.label}</span>
                  </Link>
                ))}
              </div>
            )}

            {DASHBOARD_SYSTEM_NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={cn(
                  "group flex items-center gap-3 rounded px-4 py-2 transition-all",
                  isActive(item.href)
                    ? "bg-[var(--color-primary)]/10 text-[var(--color-accent)]"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-text-main)]"
                )}
              >
                <span
                  className={cn(
                    "material-symbols-outlined text-[18px]",
                    isActive(item.href) ? "fill-1" : "transition-colors group-hover:text-[var(--color-accent)]"
                  )}
                >
                  {item.icon}
                </span>
                <span className="text-sm font-medium">{item.label}</span>
              </Link>
            ))}

            {/* Debug items (inside System section, before Settings) */}
            {DASHBOARD_DEBUG_NAV_ITEMS.map((item) => {
              const show = item.href !== "/dashboard/translator" || enableTranslator;
              return show ? (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={cn(
                    "group flex items-center gap-3 rounded px-4 py-2 transition-all",
                    isActive(item.href)
                      ? "bg-[var(--color-primary)]/10 text-[var(--color-accent)]"
                      : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-text-main)]"
                  )}
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-[18px]",
                      isActive(item.href) ? "fill-1" : "transition-colors group-hover:text-[var(--color-accent)]"
                    )}
                  >
                    {item.icon}
                  </span>
                  <span className="text-sm font-medium">{item.label}</span>
                </Link>
              ) : null;
            })}

            {/* Settings */}
            <Link
              href={DASHBOARD_SETTINGS_NAV_ITEM.href}
              onClick={onClose}
              className={cn(
                "group flex items-center gap-3 rounded px-4 py-2 transition-all",
                isActive(DASHBOARD_SETTINGS_NAV_ITEM.href)
                  ? "bg-[var(--color-primary)]/10 text-[var(--color-accent)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-text-main)]"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px]",
                  isActive(DASHBOARD_SETTINGS_NAV_ITEM.href) ? "fill-1" : "transition-colors group-hover:text-[var(--color-accent)]"
                )}
              >
                {DASHBOARD_SETTINGS_NAV_ITEM.icon}
              </span>
              <span className="text-sm font-medium">{DASHBOARD_SETTINGS_NAV_ITEM.label}</span>
            </Link>
          </div>
        </nav>

        {/* Footer section */}
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] p-4">
          {routingStatus && (
            <div className={cn(
              "flex items-center justify-between rounded border px-3 py-2.5 text-xs transition-all duration-300",
              "bg-[var(--color-bg-alt)]",
              routingStatus.className
            )}>
              <div className="flex items-center gap-2.5">
                <div className="relative flex size-2 items-center justify-center">
                  <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-30", routingStatus.dotClassName)} />
                  <span className={cn("relative inline-flex size-2 rounded-full", routingStatus.dotClassName)} />
                </div>
                <span className="font-medium tracking-tight text-[var(--color-text-main)]">{routingStatus.label}</span>
              </div>
              <span className="max-w-[140px] truncate text-[10px] font-medium opacity-60 mix-blend-luminosity">
                {routingStatus.detail}
              </span>
            </div>
          )}
          {/* Shutdown button */}
          <Button
            variant="outline"
            fullWidth
            icon="power_settings_new"
            onClick={() => setShowShutdownModal(true)}
            className="border-[var(--color-danger)]/30 text-[var(--color-danger)] hover:border-[var(--color-danger)]/40 hover:bg-[var(--color-danger)]/10"
          >
            Shutdown
          </Button>
        </div>
      </aside>

      {/* Shutdown Confirmation Modal */}
      <ConfirmModal
        isOpen={showShutdownModal}
        onClose={() => setShowShutdownModal(false)}
        onConfirm={handleShutdown}
        title="Close Proxy"
        message="Are you sure you want to close the proxy server?"
        confirmText="Close"
        cancelText="Cancel"
        variant="danger"
        loading={isShuttingDown}
      />

      {/* Update Confirmation Modal */}
      <ConfirmModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleUpdate}
        title="Update 9Router"
        message={`This will close 9Router and install v${updateInfo?.latestVersion || ""} in a separate window. Continue?`}
        confirmText="Update"
        cancelText="Cancel"
        variant="primary"
        loading={isUpdating}
      />

      {/* Disconnected Overlay */}
      {isDisconnected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--color-sidebar)_80%,transparent)]">
          <div className="text-center p-8">
            {isUpdating ? (
              <>
                <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-[var(--color-success)]/20 text-[var(--color-success)]">
                  <span className="material-symbols-outlined text-[32px]">download</span>
                </div>
                <h2 className="mb-2 text-xl font-semibold text-[var(--color-text-inverse)]">Updating 9Router</h2>
                <p className="mb-6 text-[var(--color-text-muted)]">
                  A new terminal window is installing the update. Once finished, run <code className="text-[var(--color-success)]">9router</code> again.
                </p>
              </>
            ) : (
              <>
                <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-[var(--color-danger)]/20 text-[var(--color-danger)]">
                  <span className="material-symbols-outlined text-[32px]">power_off</span>
                </div>
                <h2 className="mb-2 text-xl font-semibold text-[var(--color-text-inverse)]">Server Disconnected</h2>
                <p className="mb-6 text-[var(--color-text-muted)]">The proxy server has been stopped.</p>
                <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                  Reload Page
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};
