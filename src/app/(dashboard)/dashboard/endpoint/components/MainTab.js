"use client";

import { useState, useEffect } from "react";
import { Button, Input, Modal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import GlassCard from "./shared/GlassCard";
import StatusBadge from "./shared/StatusBadge";
import ToggleRow from "./shared/ToggleRow";
import SectionHeader from "./shared/SectionHeader";

const KEYS_PER_PAGE = 10;

export default function MainTab({ machineId }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState(null);
  const [visibleKeys, setVisibleKeys] = useState(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [requireApiKey, setRequireApiKey] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [hasPassword, setHasPassword] = useState(true);
  const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsUrl, setTsUrl] = useState("");

  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    fetchData();

    const scheduleLoadSettings = () => loadSettings();

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(scheduleLoadSettings);
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = setTimeout(scheduleLoadSettings, 0);
    return () => clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(keys.length / KEYS_PER_PAGE));
    setCurrentPage((prev) => Math.min(prev, totalPages));
  }, [keys.length]);

  const fetchData = async () => {
    try {
      const res = await fetch("/api/keys");
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys || []);
      }
    } catch (error) {
      console.error("Failed to fetch keys:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadSettings = async () => {
    try {
      const [settingsRes, tunnelRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/tunnel/status"),
      ]);

      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setRequireApiKey(data.requireApiKey || false);
        setRequireLogin(data.requireLogin !== false);
        setHasPassword(data.hasPassword || false);
        setTunnelDashboardAccess(data.tunnelDashboardAccess || false);
      }

      if (tunnelRes.ok) {
        const tunnelData = await tunnelRes.json();
        setTunnelEnabled(tunnelData.tunnel?.enabled || false);
        setTunnelUrl(tunnelData.tunnel?.publicUrl || tunnelData.tunnel?.tunnelUrl || "");
        setTsEnabled(tunnelData.tailscale?.enabled || false);
        setTsUrl(tunnelData.tailscale?.tunnelUrl || "");
      }
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setSettingsLoading(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(keys.length / KEYS_PER_PAGE));
  const paginatedKeys = keys.slice(
    (currentPage - 1) * KEYS_PER_PAGE,
    currentPage * KEYS_PER_PAGE,
  );

  const handleAddKey = async () => {
    if (!newKeyName.trim()) return;

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName }),
      });

      if (res.ok) {
        const data = await res.json();
        setCreatedKey(data.key);
        setNewKeyName("");
        await fetchData();
      }
    } catch (error) {
      console.error("Failed to add key:", error);
    }
  };

  const handleDeleteKey = async (keyId) => {
    if (!confirm("Delete this API key?")) return;

    try {
      const res = await fetch(`/api/keys/${keyId}`, { method: "DELETE" });
      if (res.ok) {
        await fetchData();
      }
    } catch (error) {
      console.error("Failed to delete key:", error);
    }
  };

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) {
        next.delete(keyId);
      } else {
        next.add(keyId);
      }
      return next;
    });
  };

  const saveSetting = async (key, value) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
    } catch (error) {
      console.error("Failed to save setting:", error);
    }
  };

  if (loading) {
    return <div className="text-[var(--color-text-muted)]">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {/* API Keys */}
      <GlassCard>
        <SectionHeader
          title="API Keys"
          subtitle="Manage API keys for accessing your 9Router instance"
        />
        <div className="space-y-3 mt-4">
          {paginatedKeys.map((key) => (
            <div key={key.id} className="flex flex-col items-start gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3 sm:flex-row sm:items-center">
              <div className="flex-1">
                <div className="text-sm font-medium text-[var(--color-text-main)]">{key.name}</div>
                <div className="mt-1 text-xs font-mono text-[var(--color-text-muted)]">
                  {visibleKeys.has(key.id) ? key.key : "••••••••••••••••"}
                </div>
              </div>
              <button
                onClick={() => toggleKeyVisibility(key.id)}
                className="rounded p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-main)]"
              >
                <span className="material-symbols-outlined text-[18px]">
                  {visibleKeys.has(key.id) ? "visibility_off" : "visibility"}
                </span>
              </button>
              <button
                onClick={() => copy(key.key, `key-${key.id}`)}
                className="rounded p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-main)]"
              >
                <span className="material-symbols-outlined text-[18px]">
                  {copied === `key-${key.id}` ? "check" : "content_copy"}
                </span>
              </button>
              <button
                onClick={() => handleDeleteKey(key.id)}
                className="rounded p-2 text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/10"
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
              </button>
            </div>
          ))}
          {keys.length > KEYS_PER_PAGE && (
            <div className="flex items-center justify-between gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2">
              <div className="text-xs text-[var(--color-text-muted)]">
                Showing {(currentPage - 1) * KEYS_PER_PAGE + 1}-{Math.min(currentPage * KEYS_PER_PAGE, keys.length)} of {keys.length} keys
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                  disabled={currentPage === 1}
                >
                  Prev
                </Button>
                <div className="min-w-[72px] text-center text-xs text-[var(--color-text-muted)]">
                  Page {currentPage} / {totalPages}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
          <Button onClick={() => setShowAddModal(true)} fullWidth>
            Add New Key
          </Button>
        </div>
      </GlassCard>

      {/* Local Endpoints */}
      <GlassCard>
        <SectionHeader title="Local Endpoints" subtitle="Your local 9Router API endpoints" />
        <div className="space-y-3 mt-4">
          <div className="flex items-center gap-2">
            <Input value="http://localhost:20128/v1" readOnly className="flex-1 font-mono text-sm" />
            <button
              onClick={() => copy("http://localhost:20128/v1", "local-url")}
              className="rounded p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-main)]"
            >
              <span className="material-symbols-outlined text-[18px]">
                {copied === "local-url" ? "check" : "content_copy"}
              </span>
            </button>
          </div>
          <div className="text-xs text-[var(--color-text-muted)]">
            Machine ID: <span className="font-mono">{machineId}</span>
          </div>
        </div>
      </GlassCard>

      {/* Remote Access */}
      <GlassCard>
        <SectionHeader title="Remote Access" subtitle="Enable remote access to your local instance" />
        <div className="space-y-4 mt-4">
          {settingsLoading && (
            <div className="text-xs text-[var(--color-text-muted)]">Loading tunnel status...</div>
          )}
          <div className="flex items-center justify-between rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
            <div className="flex-1">
              <div className="text-sm font-medium text-[var(--color-text-main)]">Cloudflare Tunnel</div>
              {tunnelEnabled && tunnelUrl && (
                <div className="mt-1 text-xs font-mono text-[var(--color-text-muted)]">{tunnelUrl}</div>
              )}
            </div>
            <StatusBadge status={tunnelEnabled ? "Enabled" : "Disabled"} />
            <Button size="sm" variant="secondary" className="ml-3">
              {tunnelEnabled ? "Disable" : "Enable"}
            </Button>
          </div>
          <div className="flex items-center justify-between rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
            <div className="flex-1">
              <div className="text-sm font-medium text-[var(--color-text-main)]">Tailscale Funnel</div>
              {tsEnabled && tsUrl && (
                <div className="mt-1 text-xs font-mono text-[var(--color-text-muted)]">{tsUrl}</div>
              )}
            </div>
            <StatusBadge status={tsEnabled ? "Enabled" : "Disabled"} />
            <Button size="sm" variant="secondary" className="ml-3">
              {tsEnabled ? "Disable" : "Enable"}
            </Button>
          </div>
        </div>
      </GlassCard>

      {/* Security Settings */}
      <GlassCard>
        <SectionHeader title="Security Settings" subtitle="Configure access control and authentication" />
        <div className="space-y-3 mt-4">
          {settingsLoading && (
            <div className="text-xs text-[var(--color-text-muted)]">Loading security settings...</div>
          )}
          <ToggleRow
            label="Require API Key"
            description="Require API key for all requests"
            checked={requireApiKey}
            onChange={(checked) => {
              setRequireApiKey(checked);
              saveSetting("requireApiKey", checked);
            }}
          />
          <ToggleRow
            label="Require Login"
            description="Require authentication to access dashboard"
            checked={requireLogin}
            onChange={(checked) => {
              setRequireLogin(checked);
              saveSetting("requireLogin", checked);
            }}
          />
          <ToggleRow
            label="Tunnel Dashboard Access"
            description="Allow dashboard access via tunnel URLs"
            checked={tunnelDashboardAccess}
            onChange={(checked) => {
              setTunnelDashboardAccess(checked);
              saveSetting("tunnelDashboardAccess", checked);
            }}
          />
        </div>
      </GlassCard>

      {/* Add Key Modal */}
      <Modal isOpen={showAddModal} title="Add API Key" onClose={() => setShowAddModal(false)}>
        <div className="space-y-4">
          <Input
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="My API Key"
          />
          {createdKey && (
            <div className="rounded border border-[var(--color-success)]/20 bg-[var(--color-success)]/10 p-3">
              <div className="mb-2 text-sm font-medium text-[var(--color-success)]">
                Key created successfully!
              </div>
              <div className="break-all text-xs font-mono text-[var(--color-text-main)]">{createdKey}</div>
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={handleAddKey} fullWidth>
              Create Key
            </Button>
            <Button onClick={() => setShowAddModal(false)} variant="ghost" fullWidth>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
