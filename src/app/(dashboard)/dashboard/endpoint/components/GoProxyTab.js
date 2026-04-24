"use client";

import { useState, useEffect } from "react";
import { Button, Input } from "@/shared/components";
import GlassCard from "./shared/GlassCard";
import StatusBadge from "./shared/StatusBadge";
import SectionHeader from "./shared/SectionHeader";

export default function GoProxyTab() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [logs, setLogs] = useState([]);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [port, setPort] = useState(20138);
  const [httpTimeout, setHttpTimeout] = useState(30);
  const [showConfirm, setShowConfirm] = useState(false);
  const [tokens, setTokens] = useState(null);
  const [tokensVisible, setTokensVisible] = useState(false);
  const [regeneratingTokens, setRegeneratingTokens] = useState(false);

  useEffect(() => {
    fetchStatus();
    fetchTokens();
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    // Auto-expand logs if there's an error
    if (status?.lastError && !logsExpanded) {
      setLogsExpanded(true);
    }
  }, [status?.lastError]);

  useEffect(() => {
    if (logsExpanded) {
      fetchLogs();
      const interval = setInterval(fetchLogs, 2000);
      return () => clearInterval(interval);
    }
  }, [logsExpanded]);

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/runtime/go-proxy");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        setPort(data.port || 20138);
        setHttpTimeout(data.httpTimeoutSeconds || 30);
      } else {
        console.error("Failed to fetch status: HTTP", res.status);
      }
    } catch (error) {
      console.error("Failed to fetch status:", error);
      // Set offline status on network error
      setStatus(prev => prev || { running: false, lastError: "Cannot connect to server" });
    } finally {
      setLoading(false);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch("/api/runtime/go-proxy/logs?lines=50");
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch (error) {
      console.error("Failed to fetch logs:", error);
    }
  };

  const fetchTokens = async () => {
    try {
      const res = await fetch("/api/runtime/go-proxy/tokens");
      if (res.ok) {
        const data = await res.json();
        setTokens(data);
      }
    } catch (error) {
      console.error("Failed to fetch tokens:", error);
    }
  };

  const handleRegenerateTokens = async () => {
    if (!confirm("Regenerate internal proxy tokens? This will require restarting Go Proxy.")) return;

    setRegeneratingTokens(true);
    try {
      const res = await fetch("/api/runtime/go-proxy/tokens", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setTokens(data);
        alert("Tokens regenerated successfully. Please restart Go Proxy for changes to take effect.");
      }
    } catch (error) {
      console.error("Failed to regenerate tokens:", error);
      alert("Failed to regenerate tokens");
    } finally {
      setRegeneratingTokens(false);
    }
  };

  const handleStart = async () => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/runtime/go-proxy/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port, httpTimeoutSeconds: httpTimeout }),
      });
      if (res.ok) {
        await fetchStatus();
      } else {
        const error = await res.json();
        alert(`Failed to start: ${error.error || "Unknown error"}`);
      }
    } catch (error) {
      console.error("Failed to start:", error);
      alert(`Failed to start: ${error.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/runtime/go-proxy/stop", { method: "POST" });
      if (res.ok) {
        await fetchStatus();
      }
    } catch (error) {
      console.error("Failed to stop:", error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestart = async () => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/runtime/go-proxy/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port, httpTimeoutSeconds: httpTimeout }),
      });
      if (res.ok) {
        await fetchStatus();
      }
    } catch (error) {
      console.error("Failed to restart:", error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveConfig = () => {
    setShowConfirm(true);
  };

  const confirmSaveConfig = async () => {
    setShowConfirm(false);
    await handleRestart();
  };

  const formatUptime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  };

  if (loading) {
    return <div className="text-[var(--color-text-muted)]">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <GlassCard>
        <SectionHeader
          label="GO PROXY RUNTIME"
          title="Runtime Management"
          subtitle="Manage the Go Proxy data plane for high-performance request forwarding"
          badge={<StatusBadge status={status?.running ? "Running" : "Stopped"} />}
        />

        <div className="space-y-6 mt-6">
          {/* Status Section */}
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="w-24 text-[var(--color-text-muted)]">Binary:</span>
              <span className={`font-medium ${status?.binaryExists ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}>
                {status?.binaryExists ? "✓ Detected" : "✗ Not Found"}
              </span>
              {status?.binaryExists && (
                <span className="text-xs text-[var(--color-text-muted)]">
                  (Auto-start {status?.autoStartEnabled ? "enabled" : "disabled"})
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 text-[var(--color-text-muted)]">Runtime:</span>
              <span className="font-medium text-[var(--color-text-main)]">{status?.running ? "Running" : "Stopped"}</span>
            </div>
            {status?.running && (
              <>
                <div className="flex items-center gap-2">
                  <span className="w-24 text-[var(--color-text-muted)]">Uptime:</span>
                  <span className="text-[var(--color-text-main)]">{formatUptime(status.uptime || 0)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-24 text-[var(--color-text-muted)]">Port:</span>
                  <span className="text-[var(--color-text-main)]">{status.port}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-24 text-[var(--color-text-muted)]">Requests:</span>
                  <span className="text-[var(--color-text-main)]">{status.requestCount?.toLocaleString() || 0}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-24 text-[var(--color-text-muted)]">Health:</span>
                  <span className={status.health?.connected ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}>
                    {status.health?.connected ? "✓ Connected to NineRouter" : "✗ Not connected"}
                  </span>
                  {status.health?.latency && (
                    <span className="text-xs text-[var(--color-text-muted)]">
                      ({status.health.latency}ms)
                    </span>
                  )}
                </div>
              </>
            )}
            {!status?.running && status?.lastError && (
              <div className="flex items-start gap-2">
                <span className="w-24 text-[var(--color-text-muted)]">Last Error:</span>
                <span className="flex-1 text-[var(--color-danger)]">{status.lastError}</span>
              </div>
            )}
          </div>

          <div className="border-t border-[var(--color-border)]" />

          {/* Controls Section */}
          <div className="flex gap-2">
            <Button
              onClick={handleStart}
              disabled={status?.running || actionLoading}
              variant="secondary"
              className="border-[var(--color-success)] bg-[var(--color-success)] text-white hover:bg-[var(--color-success)]/90"
            >
              {actionLoading ? "Starting..." : "Start"}
            </Button>
            <Button
              onClick={handleStop}
              disabled={!status?.running || actionLoading}
              variant="ghost"
            >
              {actionLoading ? "Stopping..." : "Stop"}
            </Button>
            <Button
              onClick={handleRestart}
              disabled={!status?.running || actionLoading}
              className="bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]"
            >
              {actionLoading ? "Restarting..." : "Restart"}
            </Button>
          </div>

          <div className="border-t border-[var(--color-border)]" />

          {/* Configuration Section */}
          <div className="space-y-4">
            <h4 className="text-sm font-medium text-[var(--color-text-main)]">Configuration</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Port"
                type="number"
                value={port}
                onChange={(e) => setPort(parseInt(e.target.value, 10))}
                min={1024}
                max={65535}
              />
              <Input
                label="HTTP Timeout (seconds)"
                type="number"
                value={httpTimeout}
                onChange={(e) => setHttpTimeout(parseInt(e.target.value, 10))}
                min={5}
                max={300}
              />
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              <span className="font-medium">Binary Path:</span> ~/.9router/bin/9router-go-proxy
            </div>
            
            {/* Internal Tokens Section */}
            <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-[var(--color-text-main)]">Internal Proxy Tokens</h4>
                <Button
                  size="sm"
                  onClick={handleRegenerateTokens}
                  disabled={regeneratingTokens}
                  variant="ghost"
                >
                  {regeneratingTokens ? "Regenerating..." : "Regenerate"}
                </Button>
              </div>
              {tokens && (
                <div className="space-y-2">
                  <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
                    <div className="mb-1 text-xs text-[var(--color-text-muted)]">Resolve Token</div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 break-all text-xs font-mono text-[var(--color-text-main)]">
                        {tokensVisible ? tokens.resolveToken : "••••••••••••••••••••••••••••••••"}
                      </div>
                      <button
                        onClick={() => setTokensVisible(!tokensVisible)}
                        className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-main)]"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {tokensVisible ? "visibility_off" : "visibility"}
                        </span>
                      </button>
                    </div>
                  </div>
                  <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
                    <div className="mb-1 text-xs text-[var(--color-text-muted)]">Report Token</div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 break-all text-xs font-mono text-[var(--color-text-main)]">
                        {tokensVisible ? tokens.reportToken : "••••••••••••••••••••••••••••••••"}
                      </div>
                      <button
                        onClick={() => setTokensVisible(!tokensVisible)}
                        className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-main)]"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {tokensVisible ? "visibility_off" : "visibility"}
                        </span>
                      </button>
                    </div>
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    Auto-generated on first use. Regenerate if compromised.
                  </div>
                </div>
              )}
            </div>
            
            <div className="flex justify-end">
              <Button
                onClick={handleSaveConfig}
                className="bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]"
              >
                Save Config
              </Button>
            </div>
          </div>

          <div className="border-t border-[var(--color-border)]" />

          {/* Logs Section */}
          <div>
            <button
              onClick={() => setLogsExpanded(!logsExpanded)}
              className={`flex items-center gap-2 text-sm font-medium transition-colors ${
                status?.lastError 
                  ? "text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300" 
                  : "text-text hover:text-primary"
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">
                {logsExpanded ? "expand_more" : "chevron_right"}
              </span>
              Logs
              {status?.lastError && (
                <span className="ml-2 px-2 py-0.5 text-xs bg-red-500/20 text-red-600 dark:text-red-400 rounded">
                  Error detected
                </span>
              )}
            </button>
            {logsExpanded && (
              <div className="mt-3 bg-black/20 dark:bg-white/5 rounded-lg p-3 max-h-[300px] overflow-y-auto font-mono text-xs text-text-muted">
                {logs.length === 0 ? (
                  <div className="text-center py-4">No logs available</div>
                ) : (
                  logs.map((log, i) => (
                    <div 
                      key={i} 
                      className={`whitespace-pre-wrap break-all ${
                        log.includes("[ERROR]") ? "text-red-600 dark:text-red-400" : ""
                      }`}
                    >
                      {log}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </GlassCard>

      {/* Confirmation Modal */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-text-main)]/50 px-4">
          <div className="max-w-md rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <h3 className="mb-2 text-lg font-semibold text-[var(--color-text-main)]">Restart Go Proxy?</h3>
            <p className="mb-4 text-sm text-[var(--color-text-muted)]">
              Saving will restart Go Proxy with the new configuration. Continue?
            </p>
            <div className="flex gap-2 justify-end">
              <Button onClick={() => setShowConfirm(false)} variant="ghost">
                Cancel
              </Button>
              <Button
                onClick={confirmSaveConfig}
                className="bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]"
              >
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
