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
      }
    } catch (error) {
      console.error("Failed to fetch status:", error);
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
      }
    } catch (error) {
      console.error("Failed to start:", error);
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
    return <div className="text-text-muted">Loading...</div>;
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
              <span className="text-text-muted w-24">Runtime:</span>
              <span className="text-text font-medium">{status?.running ? "Running" : "Stopped"}</span>
            </div>
            {status?.running && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted w-24">Uptime:</span>
                  <span className="text-text">{formatUptime(status.uptime || 0)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted w-24">Port:</span>
                  <span className="text-text">{status.port}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted w-24">Requests:</span>
                  <span className="text-text">{status.requestCount?.toLocaleString() || 0}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted w-24">Health:</span>
                  <span className={status.health?.connected ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                    {status.health?.connected ? "✓ Connected to NineRouter" : "✗ Not connected"}
                  </span>
                </div>
              </>
            )}
            {!status?.running && status?.lastError && (
              <div className="flex items-start gap-2">
                <span className="text-text-muted w-24">Last Error:</span>
                <span className="text-red-600 dark:text-red-400 flex-1">{status.lastError}</span>
              </div>
            )}
          </div>

          <div className="border-t border-white/10" />

          {/* Controls Section */}
          <div className="flex gap-2">
            <Button
              onClick={handleStart}
              disabled={status?.running || actionLoading}
              className="bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white"
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
              className="bg-gradient-to-r from-blue-500 to-violet-500 hover:from-blue-600 hover:to-violet-600 text-white"
            >
              {actionLoading ? "Restarting..." : "Restart"}
            </Button>
          </div>

          <div className="border-t border-white/10" />

          {/* Configuration Section */}
          <div className="space-y-4">
            <h4 className="text-sm font-medium text-text">Configuration</h4>
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
            <div className="text-xs text-text-muted">
              <span className="font-medium">Binary Path:</span> ~/.9router/bin/9router-go-proxy
            </div>
            
            {/* Internal Tokens Section */}
            <div className="space-y-3 pt-4 border-t border-white/10">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-text">Internal Proxy Tokens</h4>
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
                  <div className="p-3 rounded-lg bg-black/10 dark:bg-white/5">
                    <div className="text-xs text-text-muted mb-1">Resolve Token</div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs font-mono text-text flex-1 break-all">
                        {tokensVisible ? tokens.resolveToken : "••••••••••••••••••••••••••••••••"}
                      </div>
                      <button
                        onClick={() => setTokensVisible(!tokensVisible)}
                        className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {tokensVisible ? "visibility_off" : "visibility"}
                        </span>
                      </button>
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-black/10 dark:bg-white/5">
                    <div className="text-xs text-text-muted mb-1">Report Token</div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs font-mono text-text flex-1 break-all">
                        {tokensVisible ? tokens.reportToken : "••••••••••••••••••••••••••••••••"}
                      </div>
                      <button
                        onClick={() => setTokensVisible(!tokensVisible)}
                        className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {tokensVisible ? "visibility_off" : "visibility"}
                        </span>
                      </button>
                    </div>
                  </div>
                  <div className="text-xs text-text-muted">
                    Auto-generated on first use. Regenerate if compromised.
                  </div>
                </div>
              )}
            </div>
            
            <div className="flex justify-end">
              <Button
                onClick={handleSaveConfig}
                className="bg-gradient-to-r from-primary via-blue-500 to-violet-500 hover:scale-[1.01] text-white"
              >
                Save Config
              </Button>
            </div>
          </div>

          <div className="border-t border-white/10" />

          {/* Logs Section */}
          <div>
            <button
              onClick={() => setLogsExpanded(!logsExpanded)}
              className="flex items-center gap-2 text-sm font-medium text-text hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">
                {logsExpanded ? "expand_more" : "chevron_right"}
              </span>
              Logs
            </button>
            {logsExpanded && (
              <div className="mt-3 bg-black/20 dark:bg-white/5 rounded-lg p-3 max-h-[300px] overflow-y-auto font-mono text-xs text-text-muted">
                {logs.length === 0 ? (
                  <div className="text-center py-4">No logs available</div>
                ) : (
                  logs.map((log, i) => (
                    <div key={i} className="whitespace-pre-wrap break-all">
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-sidebar border border-white/10 rounded-lg p-6 max-w-md">
            <h3 className="text-lg font-semibold text-text mb-2">Restart Go Proxy?</h3>
            <p className="text-sm text-text-muted mb-4">
              Saving will restart Go Proxy with the new configuration. Continue?
            </p>
            <div className="flex gap-2 justify-end">
              <Button onClick={() => setShowConfirm(false)} variant="ghost">
                Cancel
              </Button>
              <Button
                onClick={confirmSaveConfig}
                className="bg-gradient-to-r from-primary to-violet-500 text-white"
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
