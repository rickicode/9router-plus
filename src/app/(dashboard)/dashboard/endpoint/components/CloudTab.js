"use client";

import { useState, useEffect } from "react";
import { Button, Input } from "@/shared/components";
import GlassCard from "./shared/GlassCard";
import StatusBadge from "./shared/StatusBadge";
import ToggleRow from "./shared/ToggleRow";
import SectionHeader from "./shared/SectionHeader";

export default function CloudTab() {
  const [workerSettings, setWorkerSettings] = useState({
    roundRobin: false,
    sticky: false,
    stickyDuration: 300
  });
  const [cloudUrls, setCloudUrls] = useState([]);
  const [newCloudUrl, setNewCloudUrl] = useState("");
  const [cloudHealth, setCloudHealth] = useState(null);
  const [saving, setSaving] = useState(false);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsUrl, setTsUrl] = useState("");

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const [settingsRes, tunnelRes, cloudUrlsRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/tunnel/status"),
        fetch("/api/cloud-urls"),
      ]);

      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setWorkerSettings({
          roundRobin: data.roundRobin || false,
          sticky: data.sticky || false,
          stickyDuration: data.stickyDuration || 300
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
    } catch (error) {
      console.error("Failed to load settings:", error);
    }
  };

  const saveWorkerSettings = async () => {
    setSaving(true);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workerSettings),
      });
    } catch (error) {
      console.error("Failed to save settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleAddCloudUrl = async () => {
    if (!newCloudUrl.trim()) return;

    try {
      const res = await fetch("/api/cloud-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: newCloudUrl }),
      });

      if (res.ok) {
        setNewCloudUrl("");
        await loadSettings();
      }
    } catch (error) {
      console.error("Failed to add cloud URL:", error);
    }
  };

  const handleDeleteCloudUrl = async (url) => {
    if (!confirm("Delete this cloud URL?")) return;

    try {
      const res = await fetch("/api/cloud-urls", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (res.ok) {
        await loadSettings();
      }
    } catch (error) {
      console.error("Failed to delete cloud URL:", error);
    }
  };

  const checkCloudHealth = async () => {
    if (cloudUrls.length === 0) return;

    try {
      const primaryUrl = cloudUrls[0]?.url;
      const response = await fetch(`${primaryUrl}/worker/health`);

      if (response.ok) {
        const data = await response.json();
        setCloudHealth(data);
      } else {
        setCloudHealth({ status: "down" });
      }
    } catch (error) {
      setCloudHealth({ status: "down", error: error.message });
    }
  };

  return (
    <div className="space-y-6">
      {/* Cloudflare Tunnel Details */}
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
          <div className="text-xs text-[var(--color-text-muted)]">
            Manage tunnel settings in the Main tab
          </div>
        </div>
      </GlassCard>

      {/* Tailscale Funnel Details */}
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
          <div className="text-xs text-[var(--color-text-muted)]">
            Manage Tailscale settings in the Main tab
          </div>
        </div>
      </GlassCard>

      {/* Cloudflare Worker Settings */}
      <GlassCard>
        <SectionHeader
          label="CLOUD WORKER SETTINGS"
          title="Cloud Worker Routing"
          subtitle="Fine-tune how requests are distributed across credentials"
          badge={<StatusBadge status="Worker policy" />}
        />

        <div className="space-y-4 mt-6">
          <ToggleRow
            label="Round-Robin"
            description="Distribute requests across multiple credentials"
            checked={workerSettings.roundRobin}
            onChange={(checked) => setWorkerSettings(prev => ({ ...prev, roundRobin: checked }))}
          />

          <ToggleRow
            label="Sticky Sessions"
            description="Maintain consistent routing per client"
            checked={workerSettings.sticky}
            onChange={(checked) => setWorkerSettings(prev => ({ ...prev, sticky: checked }))}
          />

          {workerSettings.sticky && (
            <div className="pl-4">
              <Input
                label="Sticky Duration (seconds)"
                type="number"
                value={workerSettings.stickyDuration}
                onChange={(e) => setWorkerSettings(prev => ({ ...prev, stickyDuration: parseInt(e.target.value, 10) }))}
                min={60}
                max={3600}
              />
              <div className="mt-2 text-xs text-[var(--color-text-muted)]">
                Defines how long a client stays pinned to the same credential
              </div>
            </div>
          )}

          <div className="border-t border-[var(--color-border)] pt-4">
            <h4 className="mb-3 text-sm font-medium text-[var(--color-text-main)]">Cloud URLs</h4>
            <div className="space-y-2 mb-3">
              {cloudUrls.map((item, index) => (
                <div key={index} className="flex items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-2">
                  <div className="flex-1 text-sm font-mono text-[var(--color-text-main)]">{item.url}</div>
                  <button
                    onClick={() => handleDeleteCloudUrl(item.url)}
                    className="rounded p-1 text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/10"
                  >
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={newCloudUrl}
                onChange={(e) => setNewCloudUrl(e.target.value)}
                placeholder="https://worker.example.com"
                className="flex-1"
              />
              <Button variant="secondary" onClick={handleAddCloudUrl}>Add</Button>
            </div>
          </div>

          {cloudUrls.length > 0 && (
            <div className="border-t border-[var(--color-border)] pt-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium text-[var(--color-text-main)]">Cloud Health</h4>
                <Button size="sm" variant="secondary" onClick={checkCloudHealth}>
                  Refresh
                </Button>
              </div>
              {cloudHealth && (
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3">
                  <div className="text-xs text-[var(--color-text-muted)]">Status: {cloudHealth.status || "unknown"}</div>
                  {cloudHealth.lastSync && (
                    <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                      Last sync: {new Date(cloudHealth.lastSync).toLocaleString()}
                    </div>
                  )}
                </div>
              )}
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
