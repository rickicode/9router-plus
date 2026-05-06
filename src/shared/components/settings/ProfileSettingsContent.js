"use client";

import { useRef, useState, useEffect } from "react";
import { Card, Button, Toggle, Input } from "@/shared/components";
import { useTheme } from "@/shared/hooks/useTheme";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG } from "@/shared/constants/config";

const DEFAULT_CHAT_RUNTIME_SETTINGS = {
  upstreamTimeoutMs: 45000,
  compactUpstreamTimeoutMs: 300000,
  streamIdleTimeoutMs: 120000,
  maxInflight: 2000,
  providerMaxInflight: 600,
  accountMaxInflight: 80,
  observabilityMode: "full",
  observabilitySampleRate: 0.1,
  highThroughputSelection: true,
};

const MS_PER_SECOND = 1000;

function msToSecondsString(value, fallbackMs) {
  const numericValue = Number(value);
  const resolvedMs = Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallbackMs;
  return String(Math.max(1, Math.round(resolvedMs / MS_PER_SECOND)));
}

function secondsStringToMs(value) {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds)) return Number.NaN;
  return Math.round(seconds * MS_PER_SECOND);
}

function normalizeChatRuntimeForm(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    upstreamTimeoutSeconds: msToSecondsString(
      source.upstreamTimeoutMs,
      DEFAULT_CHAT_RUNTIME_SETTINGS.upstreamTimeoutMs,
    ),
    compactUpstreamTimeoutSeconds: msToSecondsString(
      source.compactUpstreamTimeoutMs,
      DEFAULT_CHAT_RUNTIME_SETTINGS.compactUpstreamTimeoutMs,
    ),
    streamIdleTimeoutSeconds: msToSecondsString(
      source.streamIdleTimeoutMs,
      DEFAULT_CHAT_RUNTIME_SETTINGS.streamIdleTimeoutMs,
    ),
    maxInflight: String(source.maxInflight ?? DEFAULT_CHAT_RUNTIME_SETTINGS.maxInflight),
    providerMaxInflight: String(source.providerMaxInflight ?? DEFAULT_CHAT_RUNTIME_SETTINGS.providerMaxInflight),
    accountMaxInflight: String(source.accountMaxInflight ?? DEFAULT_CHAT_RUNTIME_SETTINGS.accountMaxInflight),
    observabilityMode: source.observabilityMode || DEFAULT_CHAT_RUNTIME_SETTINGS.observabilityMode,
    observabilitySampleRate: String(source.observabilitySampleRate ?? DEFAULT_CHAT_RUNTIME_SETTINGS.observabilitySampleRate),
    highThroughputSelection: source.highThroughputSelection !== false,
  };
}

function buildChatRuntimePayload(form) {
  return {
    upstreamTimeoutMs: secondsStringToMs(form.upstreamTimeoutSeconds),
    compactUpstreamTimeoutMs: secondsStringToMs(form.compactUpstreamTimeoutSeconds),
    streamIdleTimeoutMs: secondsStringToMs(form.streamIdleTimeoutSeconds),
    maxInflight: Number.parseInt(form.maxInflight, 10),
    providerMaxInflight: Number.parseInt(form.providerMaxInflight, 10),
    accountMaxInflight: Number.parseInt(form.accountMaxInflight, 10),
    observabilityMode: form.observabilityMode,
    observabilitySampleRate: Number.parseFloat(form.observabilitySampleRate),
    highThroughputSelection: form.highThroughputSelection === true,
  };
}

function SectionIntro({ icon, title, description, tone = "neutral", eyebrow = "Settings" }) {
  const toneClassName = {
    success: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
    primary: "bg-[var(--color-primary)]/10 text-[var(--color-primary)]",
    info: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
    purple: "bg-[var(--color-purple-soft)] text-[var(--color-purple)]",
    warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
    neutral: "bg-[var(--color-bg-alt)] text-text-muted",
  }[tone] || "bg-[var(--color-bg-alt)] text-text-muted";

  return (
    <div className="mb-5 flex items-start gap-3 border-b border-border/70 pb-4">
      <div className={cn("flex size-10 items-center justify-center rounded-lg", toneClassName)}>
        <span className="material-symbols-outlined text-[20px]">{icon}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">{eyebrow}</p>
        <h3 className="mt-1 text-lg font-semibold text-text-main">{title}</h3>
        {description ? <p className="mt-1 text-sm text-text-muted">{description}</p> : null}
      </div>
    </div>
  );
}

export default function ProfileSettingsContent() {
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState({
    routing: {
      strategy: "fill-first",
      stickyLimit: 3,
      sticky: { enabled: false, durationSeconds: 300 },
      comboStrategy: "fallback",
      providerStrategies: {},
      comboStrategies: {},
    },
  });
  const [loading, setLoading] = useState(true);
  const [usageWorkerForm, setUsageWorkerForm] = useState({
    enabled: true,
    cadenceMinutes: "15",
    exhaustedThresholdPercent: "10",
  });
  const [usageWorkerStatus, setUsageWorkerStatus] = useState({ type: "", message: "" });
  const [usageWorkerLoading, setUsageWorkerLoading] = useState(false);
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" });
  const [passStatus, setPassStatus] = useState({ type: "", message: "" });
  const [passLoading, setPassLoading] = useState(false);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbStatus, setDbStatus] = useState({ type: "", message: "" });
  const importFileRef = useRef(null);
  const [proxyForm, setProxyForm] = useState({
    outboundProxyEnabled: false,
    outboundProxyUrl: "",
    outboundNoProxy: "",
  });
  const [proxyStatus, setProxyStatus] = useState({ type: "", message: "" });
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyTestLoading, setProxyTestLoading] = useState(false);
  const [routingStatus, setRoutingStatus] = useState({ type: "", message: "" });
  const [routingLoading, setRoutingLoading] = useState(false);
  const [stickyDurationInput, setStickyDurationInput] = useState("300");
  const [chatRuntimeForm, setChatRuntimeForm] = useState(normalizeChatRuntimeForm(DEFAULT_CHAT_RUNTIME_SETTINGS));
  const [chatRuntimeStatus, setChatRuntimeStatus] = useState({ type: "", message: "" });
  const [chatRuntimeLoading, setChatRuntimeLoading] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setSettings(data);
        setUsageWorkerForm({
          enabled: data?.usageWorker?.enabled !== false,
          cadenceMinutes: String(
            Math.max(15, Math.round((data?.usageWorker?.cadenceMs || 900000) / 60000))
          ),
          exhaustedThresholdPercent: String(
            Number.isFinite(data?.quotaExhaustedThresholdPercent)
              ? data.quotaExhaustedThresholdPercent
              : 10
          ),
        });
        setProxyForm({
          outboundProxyEnabled: data?.outboundProxyEnabled === true,
          outboundProxyUrl: data?.outboundProxyUrl || "",
          outboundNoProxy: data?.outboundNoProxy || "",
        });
        setChatRuntimeForm(normalizeChatRuntimeForm(data?.chatRuntime));
        setStickyDurationInput(String(data?.routing?.sticky?.durationSeconds || data?.stickyDuration || 300));
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch settings:", err);
        setLoading(false);
      });
  }, []);

  const reloadSettings = async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data);
      setChatRuntimeForm(normalizeChatRuntimeForm(data?.chatRuntime));
      setStickyDurationInput(String(data?.routing?.sticky?.durationSeconds || data?.stickyDuration || 300));
    } catch (err) {
      console.error("Failed to reload settings:", err);
    }
  };

  const updateUsageWorker = async (updates, successMessage = "Usage worker updated") => {
    setUsageWorkerLoading(true);
    setUsageWorkerStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...updates }),
      });
      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setUsageWorkerForm({
          enabled: data?.usageWorker?.enabled !== false,
          cadenceMinutes: String(
            Math.max(15, Math.round((data?.usageWorker?.cadenceMs || 900000) / 60000))
          ),
          exhaustedThresholdPercent: String(
            Number.isFinite(data?.quotaExhaustedThresholdPercent)
              ? data.quotaExhaustedThresholdPercent
              : 10
          ),
        });
        setUsageWorkerStatus({ type: "success", message: successMessage });
      } else {
        setUsageWorkerStatus({ type: "error", message: data.error || "Failed to update usage worker" });
      }
    } catch {
      setUsageWorkerStatus({ type: "error", message: "An error occurred" });
    } finally {
      setUsageWorkerLoading(false);
    }
  };

  const updateUsageWorkerEnabled = async (enabled) => {
    setUsageWorkerForm((prev) => ({ ...prev, enabled }));
    await updateUsageWorker(
      { usageWorker: { enabled } },
      enabled ? "Usage worker enabled" : "Usage worker disabled"
    );
  };

  const applyUsageWorkerSettings = async (e) => {
    e.preventDefault();
    const minutes = Number.parseInt(usageWorkerForm.cadenceMinutes, 10);
    if (!Number.isFinite(minutes) || minutes < 15) {
      setUsageWorkerStatus({ type: "error", message: "Scheduler interval must be at least 15 minutes" });
      return;
    }
    const threshold = Number.parseFloat(usageWorkerForm.exhaustedThresholdPercent);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      setUsageWorkerStatus({ type: "error", message: "Quota exhausted threshold must be between 0 and 100" });
      return;
    }
    await updateUsageWorker(
      {
        usageWorker: { intervalMinutes: minutes },
        quotaExhaustedThresholdPercent: threshold,
      },
      "Usage worker settings updated"
    );
  };

  const updateOutboundProxy = async (e) => {
    e.preventDefault();
    if (settings.outboundProxyEnabled !== true) return;
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outboundProxyUrl: proxyForm.outboundProxyUrl,
          outboundNoProxy: proxyForm.outboundNoProxy,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyStatus({ type: "success", message: "Proxy settings applied" });
      } else {
        setProxyStatus({ type: "error", message: data.error || "Failed to update proxy settings" });
      }
    } catch {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyLoading(false);
    }
  };

  const testOutboundProxy = async () => {
    if (settings.outboundProxyEnabled !== true) return;
    const proxyUrl = (proxyForm.outboundProxyUrl || "").trim();
    if (!proxyUrl) {
      setProxyStatus({ type: "error", message: "Please enter a Proxy URL to test" });
      return;
    }
    setProxyTestLoading(true);
    setProxyStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        setProxyStatus({
          type: "success",
          message: `Proxy test OK (${data.status}) in ${data.elapsedMs}ms`,
        });
      } else {
        setProxyStatus({ type: "error", message: data?.error || "Proxy test failed" });
      }
    } catch {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyTestLoading(false);
    }
  };

  const updateOutboundProxyEnabled = async (outboundProxyEnabled) => {
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outboundProxyEnabled }),
      });
      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyForm((prev) => ({ ...prev, outboundProxyEnabled: data?.outboundProxyEnabled === true }));
        setProxyStatus({
          type: "success",
          message: outboundProxyEnabled ? "Proxy enabled" : "Proxy disabled",
        });
      } else {
        setProxyStatus({ type: "error", message: data.error || "Failed to update proxy settings" });
      }
    } catch {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyLoading(false);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (passwords.new !== passwords.confirm) {
      setPassStatus({ type: "error", message: "Passwords do not match" });
      return;
    }
    setPassLoading(true);
    setPassStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.new,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setPassStatus({ type: "success", message: "Password updated successfully" });
        setPasswords({ current: "", new: "", confirm: "" });
      } else {
        setPassStatus({ type: "error", message: data.error || "Failed to update password" });
      }
    } catch {
      setPassStatus({ type: "error", message: "An error occurred" });
    } finally {
      setPassLoading(false);
    }
  };

  const updateFallbackStrategy = async (strategy) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routing: { strategy } }),
      });
      if (res.ok) {
        setSettings((prev) => ({
          ...prev,
          routing: { ...(prev.routing || {}), strategy },
        }));
      }
    } catch (err) {
      console.error("Failed to update settings:", err);
    }
  };

  const updateComboStrategy = async (strategy) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routing: { comboStrategy: strategy } }),
      });
      if (res.ok) {
        setSettings((prev) => ({
          ...prev,
          routing: { ...(prev.routing || {}), comboStrategy: strategy },
        }));
      }
    } catch (err) {
      console.error("Failed to update combo strategy:", err);
    }
  };

  const updateStickyLimit = async (limit) => {
    const numLimit = parseInt(limit, 10);
    if (Number.isNaN(numLimit) || numLimit < 1) return;
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routing: { stickyLimit: numLimit } }),
      });
      if (res.ok) {
        setSettings((prev) => ({
          ...prev,
          routing: { ...(prev.routing || {}), stickyLimit: numLimit },
        }));
      }
    } catch (err) {
      console.error("Failed to update sticky limit:", err);
    }
  };

  const updateRequireLogin = async (requireLogin) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireLogin }),
      });
      if (res.ok) {
        setSettings((prev) => ({ ...prev, requireLogin }));
      }
    } catch (err) {
      console.error("Failed to update require login:", err);
    }
  };

  const updateObservabilityEnabled = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableObservability: enabled }),
      });
      if (res.ok) {
        setSettings((prev) => ({ ...prev, enableObservability: enabled }));
      }
    } catch (err) {
      console.error("Failed to update enableObservability:", err);
    }
  };

  const validateChatRuntimePayload = (payload) => {
    const positiveFields = [
      ["upstreamTimeoutMs", "Upstream timeout"],
      ["compactUpstreamTimeoutMs", "Compact upstream timeout"],
      ["streamIdleTimeoutMs", "Stream idle timeout"],
      ["maxInflight", "Global concurrency"],
      ["providerMaxInflight", "Provider concurrency"],
      ["accountMaxInflight", "Account concurrency"],
    ];
    for (const [key, label] of positiveFields) {
      if (!Number.isFinite(payload[key]) || payload[key] <= 0) return `${label} must be greater than 0`;
    }
    if (!Number.isFinite(payload.observabilitySampleRate) || payload.observabilitySampleRate < 0 || payload.observabilitySampleRate > 1) {
      return "Observability sample rate must be between 0 and 1";
    }
    return null;
  };

  const saveChatRuntimeSettings = async (event) => {
    event.preventDefault();
    const payload = buildChatRuntimePayload(chatRuntimeForm);
    const validationError = validateChatRuntimePayload(payload);
    if (validationError) {
      setChatRuntimeStatus({ type: "error", message: validationError });
      return;
    }

    setChatRuntimeLoading(true);
    setChatRuntimeStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatRuntime: payload }),
      });
      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setChatRuntimeForm(normalizeChatRuntimeForm(data?.chatRuntime));
        setChatRuntimeStatus({ type: "success", message: "Chat runtime settings saved" });
      } else {
        setChatRuntimeStatus({ type: "error", message: data.error || "Failed to save chat runtime settings" });
      }
    } catch {
      setChatRuntimeStatus({ type: "error", message: "An error occurred" });
    } finally {
      setChatRuntimeLoading(false);
    }
  };

  const resetChatRuntimeDefaults = async () => {
    setChatRuntimeLoading(true);
    setChatRuntimeStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetChatRuntimeDefaults: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setChatRuntimeForm(normalizeChatRuntimeForm(data?.chatRuntime));
        setChatRuntimeStatus({ type: "success", message: "Chat runtime settings reset to defaults" });
      } else {
        setChatRuntimeStatus({ type: "error", message: data.error || "Failed to reset chat runtime settings" });
      }
    } catch {
      setChatRuntimeStatus({ type: "error", message: "An error occurred" });
    } finally {
      setChatRuntimeLoading(false);
    }
  };

  const updateCloudRoutingSettings = async (updates, successMessage) => {
    setRoutingLoading(true);
    setRoutingStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routing: updates }),
      });
      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setStickyDurationInput(String(data?.routing?.sticky?.durationSeconds || data?.stickyDuration || 300));
        setRoutingStatus({ type: "success", message: successMessage });
      } else {
        setRoutingStatus({ type: "error", message: data.error || "Failed to update routing settings" });
      }
    } catch {
      setRoutingStatus({ type: "error", message: "An error occurred" });
    } finally {
      setRoutingLoading(false);
    }
  };

  const updateCloudRoundRobin = async (enabled) => {
    await updateCloudRoutingSettings(
      { strategy: enabled ? "round-robin" : "fill-first" },
      enabled ? "Round-robin enabled" : "Round-robin disabled"
    );
  };

  const updateCloudSticky = async (enabled) => {
    await updateCloudRoutingSettings(
      { sticky: { ...(settings?.routing?.sticky || {}), enabled } },
      enabled ? "Sticky sessions enabled" : "Sticky sessions disabled"
    );
  };

  const applyCloudStickyDuration = async (value) => {
    const duration = Number.parseInt(value, 10);
    if (!Number.isFinite(duration) || duration < 60 || duration > 3600) {
      setRoutingStatus({
        type: "error",
        message: "Sticky duration must be between 60 and 3600 seconds",
      });
      setStickyDurationInput(String(settings?.routing?.sticky?.durationSeconds || settings?.stickyDuration || 300));
      return;
    }
    await updateCloudRoutingSettings(
      { sticky: { ...(settings?.routing?.sticky || {}), durationSeconds: duration } },
      "Sticky duration updated"
    );
  };

  const handleExportDatabase = async () => {
    setDbLoading(true);
    setDbStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings/database");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to export database");
      }
      const payload = await res.json();
      const content = JSON.stringify(payload, null, 2);
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      anchor.href = url;
      anchor.download = `9router-backup-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setDbStatus({ type: "success", message: "Database backup downloaded" });
    } catch (err) {
      setDbStatus({ type: "error", message: err.message || "Failed to export database" });
    } finally {
      setDbLoading(false);
    }
  };

  const handleImportDatabase = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setDbLoading(true);
    setDbStatus({ type: "", message: "" });
    try {
      const raw = await file.text();
      const payload = JSON.parse(raw);
      const res = await fetch("/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to import database");
      }
      await reloadSettings();
      setDbStatus({ type: "success", message: "Database imported successfully" });
    } catch (err) {
      setDbStatus({ type: "error", message: err.message || "Invalid backup file" });
    } finally {
      if (importFileRef.current) {
        importFileRef.current.value = "";
      }
      setDbLoading(false);
    }
  };

  const observabilityEnabled = settings.enableObservability === true;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <SectionIntro
            icon="computer"
            tone="success"
            title="Local Mode"
            description="Theme, local database access, and backup tools for this machine."
            eyebrow="Workspace"
          />
          <div className="inline-flex rounded bg-[var(--color-bg-alt)] p-1">
            {["light", "dark", "system"].map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTheme(option)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-all",
                  theme === option
                    ? "bg-[var(--color-surface)] text-text-main"
                    : "text-text-muted hover:text-text-main"
                )}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {option === "light" ? "light_mode" : option === "dark" ? "dark_mode" : "contrast"}
                </span>
                <span className="text-sm capitalize">{option}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex items-center justify-between rounded border border-border bg-[var(--color-bg)] p-3">
            <div>
              <p className="font-medium">Database Location</p>
              <p className="font-mono text-sm text-text-muted">~/.9router/db.sqlite</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon="download" onClick={handleExportDatabase} loading={dbLoading}>
              Download Backup
            </Button>
            <Button
              variant="outline"
              icon="upload"
              onClick={() => importFileRef.current?.click()}
              disabled={dbLoading}
            >
              Import Backup
            </Button>
            <input
              ref={importFileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleImportDatabase}
            />
          </div>
          {dbStatus.message ? (
            <p className={`text-sm ${dbStatus.type === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
              {dbStatus.message}
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <SectionIntro
          icon="shield"
          tone="primary"
          title="Security"
          description="Control login requirements and update the dashboard password."
          eyebrow="Access"
        />
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Require login</p>
              <p className="text-sm text-text-muted">When ON, dashboard requires password. When OFF, access without login.</p>
            </div>
            <Toggle
              checked={settings.requireLogin === true}
              onChange={() => updateRequireLogin(!settings.requireLogin)}
              disabled={loading}
            />
          </div>
          {settings.requireLogin === true ? (
            <form onSubmit={handlePasswordChange} className="flex flex-col gap-4 border-t border-border/50 pt-4">
              {settings.hasPassword ? (
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">Current Password</label>
                  <Input
                    type="password"
                    placeholder="Enter current password"
                    value={passwords.current}
                    onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                    required
                  />
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">New Password</label>
                  <Input
                    type="password"
                    placeholder="Enter new password"
                    value={passwords.new}
                    onChange={(e) => setPasswords({ ...passwords, new: e.target.value })}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">Confirm New Password</label>
                  <Input
                    type="password"
                    placeholder="Confirm new password"
                    value={passwords.confirm}
                    onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
                    required
                  />
                </div>
              </div>
              {passStatus.message ? (
                <p className={`text-sm ${passStatus.type === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
                  {passStatus.message}
                </p>
              ) : null}
              <div className="pt-2">
                <Button type="submit" variant="primary" loading={passLoading}>
                  {settings.hasPassword ? "Update Password" : "Set Password"}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      </Card>

      <Card>
        <SectionIntro
          icon="route"
          tone="info"
          title="Routing Strategy"
          description="Use one shared routing configuration for local 9Router and all synced cloud workers."
          eyebrow="Routing"
        />
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Round Robin</p>
              <p className="text-sm text-text-muted">Cycle through accounts to distribute load everywhere.</p>
            </div>
            <Toggle
              checked={settings.routing?.strategy === "round-robin"}
              onChange={() =>
                updateFallbackStrategy(
                  settings.routing?.strategy === "round-robin" ? "fill-first" : "round-robin"
                )
              }
              disabled={loading || routingLoading}
            />
          </div>
          {settings.routing?.strategy === "round-robin" ? (
            <div className="flex items-center justify-between border-t border-border/50 pt-2">
              <div>
                <p className="font-medium">Sticky Limit</p>
                <p className="text-sm text-text-muted">Calls per account before switching</p>
              </div>
              <Input
                type="number"
                min="1"
                max="10"
                value={settings.routing?.stickyLimit || 3}
                onChange={(e) => updateStickyLimit(e.target.value)}
                disabled={loading || routingLoading}
                className="w-20 text-center"
              />
            </div>
          ) : null}
          <div className="flex items-center justify-between border-t border-border/50 pt-4">
            <div>
              <p className="font-medium">Combo Round Robin</p>
              <p className="text-sm text-text-muted">Cycle through providers in combos instead of always starting with first</p>
            </div>
            <Toggle
              checked={settings.routing?.comboStrategy === "round-robin"}
              onChange={() =>
                updateComboStrategy(
                  settings.routing?.comboStrategy === "round-robin" ? "fallback" : "round-robin"
                )
              }
              disabled={loading || routingLoading}
            />
          </div>
          <p className="border-t border-border/50 pt-3 text-sm text-text-muted">
            {settings.routing?.strategy === "round-robin"
              ? `Currently distributing requests across all available accounts with ${settings.routing?.stickyLimit || 3} calls per account.`
              : "Currently using accounts in priority order (Fill First)."}
          </p>
        </div>
      </Card>

      <Card>
        <SectionIntro
          icon="cloud_sync"
          tone="primary"
          title="Cloud Worker Routing"
          description="This is the only place that controls routing behavior synced to every cloud worker."
          eyebrow="Cloud"
        />
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Sticky Sessions</p>
              <p className="text-sm text-text-muted">Keep a client on the same connection across local and cloud routes.</p>
            </div>
            <Toggle
              checked={settings.routing?.sticky?.enabled === true}
              onChange={() => updateCloudSticky(!(settings.routing?.sticky?.enabled === true))}
              disabled={loading || routingLoading}
            />
          </div>
          <div className="border-t border-border/50 pt-4">
            <Input
              type="number"
              min="60"
              max="3600"
              step="1"
              label="Sticky Duration"
              value={stickyDurationInput}
              onChange={(e) => {
                setStickyDurationInput(e.target.value);
                if (routingStatus.message) setRoutingStatus({ type: "", message: "" });
              }}
              onBlur={(e) => applyCloudStickyDuration(e.target.value)}
              disabled={loading || routingLoading}
              hint="Duration in seconds. Saved once and used by local + cloud routing together."
              className="w-full"
            />
          </div>
          <p className="border-t border-border/50 pt-3 text-sm text-text-muted">
            {settings.routing?.strategy === "round-robin"
              ? `Currently distributing requests across all available accounts with ${settings.routing?.stickyLimit || 3} calls per account.`
              : "Currently using accounts in priority order (Fill First)."}
          </p>
          {routingStatus.message ? (
            <p className={`text-sm ${routingStatus.type === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
              {routingStatus.message}
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <SectionIntro
          icon="wifi"
          tone="purple"
          title="Network"
          description="Configure outbound proxy behavior for provider and OAuth traffic."
          eyebrow="Connectivity"
        />
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Outbound Proxy</p>
              <p className="text-sm text-text-muted">Enable proxy for OAuth + provider outbound requests.</p>
            </div>
            <Toggle
              checked={settings.outboundProxyEnabled === true}
              onChange={() => updateOutboundProxyEnabled(!(settings.outboundProxyEnabled === true))}
              disabled={loading || proxyLoading}
            />
          </div>
          {settings.outboundProxyEnabled === true ? (
            <form onSubmit={updateOutboundProxy} className="flex flex-col gap-4 border-t border-border/50 pt-2">
              <div className="flex flex-col gap-2">
                <label className="font-medium">Proxy URL</label>
                <Input
                  placeholder="http://127.0.0.1:7897"
                  value={proxyForm.outboundProxyUrl}
                  onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundProxyUrl: e.target.value }))}
                  disabled={loading || proxyLoading}
                />
                <p className="text-sm text-text-muted">Leave empty to inherit existing env proxy (if any).</p>
              </div>
              <div className="flex flex-col gap-2 border-t border-border/50 pt-2">
                <label className="font-medium">No Proxy</label>
                <Input
                  placeholder="localhost,127.0.0.1"
                  value={proxyForm.outboundNoProxy}
                  onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundNoProxy: e.target.value }))}
                  disabled={loading || proxyLoading}
                />
                <p className="text-sm text-text-muted">Comma-separated hostnames/domains to bypass the proxy.</p>
              </div>
              <div className="flex items-center gap-2 border-t border-border/50 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  loading={proxyTestLoading}
                  disabled={loading || proxyLoading}
                  onClick={testOutboundProxy}
                >
                  Test proxy URL
                </Button>
                <Button type="submit" variant="primary" loading={proxyLoading}>
                  Apply
                </Button>
              </div>
            </form>
          ) : null}
          {proxyStatus.message ? (
            <p className={`border-t border-border/50 pt-2 text-sm ${proxyStatus.type === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
              {proxyStatus.message}
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <SectionIntro
          icon="monitoring"
          tone="warning"
          title="Observability"
          description="Capture request details for debugging and usage inspection."
          eyebrow="Monitoring"
        />
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">Enable Observability</p>
            <p className="text-sm text-text-muted">Record request details for inspection in the logs view</p>
          </div>
          <Toggle checked={observabilityEnabled} onChange={updateObservabilityEnabled} disabled={loading} />
        </div>
      </Card>

      <Card>
        <SectionIntro
          icon="speed"
          tone="primary"
          title="Chat Runtime"
          description="Tune /v1 timeout, concurrency, observability mode, and high-throughput account selection from saved settings."
          eyebrow="Performance"
        />
        <form onSubmit={saveChatRuntimeSettings} className="flex flex-col gap-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Input
              type="number"
              min="1"
              step="1"
              label="Upstream timeout (seconds)"
              value={chatRuntimeForm.upstreamTimeoutSeconds}
              onChange={(e) => setChatRuntimeForm((prev) => ({ ...prev, upstreamTimeoutSeconds: e.target.value }))}
              disabled={loading || chatRuntimeLoading}
              hint="Default 45. Saved to backend in milliseconds."
            />
            <Input
              type="number"
              min="1"
              step="1"
              label="Compact upstream timeout (seconds)"
              value={chatRuntimeForm.compactUpstreamTimeoutSeconds}
              onChange={(e) => setChatRuntimeForm((prev) => ({ ...prev, compactUpstreamTimeoutSeconds: e.target.value }))}
              disabled={loading || chatRuntimeLoading}
              hint="Default 300. Used for compact flows across all providers."
            />
            <Input
              type="number"
              min="1"
              step="1"
              label="Stream idle timeout (seconds)"
              value={chatRuntimeForm.streamIdleTimeoutSeconds}
              onChange={(e) => setChatRuntimeForm((prev) => ({ ...prev, streamIdleTimeoutSeconds: e.target.value }))}
              disabled={loading || chatRuntimeLoading}
              hint="Default 120. Saved to backend in milliseconds."
            />
            <Input
              type="number"
              min="1"
              step="1"
              label="Global max in-flight"
              value={chatRuntimeForm.maxInflight}
              onChange={(e) => setChatRuntimeForm((prev) => ({ ...prev, maxInflight: e.target.value }))}
              disabled={loading || chatRuntimeLoading}
              hint="Default 2000."
            />
            <Input
              type="number"
              min="1"
              step="1"
              label="Provider max in-flight"
              value={chatRuntimeForm.providerMaxInflight}
              onChange={(e) => setChatRuntimeForm((prev) => ({ ...prev, providerMaxInflight: e.target.value }))}
              disabled={loading || chatRuntimeLoading}
              hint="Default 600 per provider."
            />
            <Input
              type="number"
              min="1"
              step="1"
              label="Account max in-flight"
              value={chatRuntimeForm.accountMaxInflight}
              onChange={(e) => setChatRuntimeForm((prev) => ({ ...prev, accountMaxInflight: e.target.value }))}
              disabled={loading || chatRuntimeLoading}
              hint="Default 80 per account."
            />
            <Input
              type="number"
              min="0"
              max="1"
              step="0.01"
              label="Observability sample rate"
              value={chatRuntimeForm.observabilitySampleRate}
              onChange={(e) => setChatRuntimeForm((prev) => ({ ...prev, observabilitySampleRate: e.target.value }))}
              disabled={loading || chatRuntimeLoading}
              hint="0 to 1. Used when mode is sampled."
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-text-main">
              <span className="font-medium">Observability mode</span>
              <select
                value={chatRuntimeForm.observabilityMode}
                onChange={(e) => setChatRuntimeForm((prev) => ({ ...prev, observabilityMode: e.target.value }))}
                disabled={loading || chatRuntimeLoading}
                className="min-h-11 rounded border border-border bg-[var(--color-bg)] px-3 py-2 text-sm text-text-main outline-none transition focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30"
              >
                <option value="full">Full</option>
                <option value="sampled">Sampled</option>
                <option value="minimal">Minimal errors only</option>
                <option value="off">Off</option>
              </select>
              <span className="text-sm text-text-muted">Controls request log/detail persistence for high traffic.</span>
            </label>
            <div className="flex items-center justify-between rounded border border-border bg-[var(--color-bg)] p-3">
              <div>
                <p className="font-medium">High-throughput selection</p>
                <p className="text-sm text-text-muted">Use cached provider lists and memory round-robin cursor.</p>
              </div>
              <Toggle
                checked={chatRuntimeForm.highThroughputSelection}
                onChange={(enabled) => setChatRuntimeForm((prev) => ({ ...prev, highThroughputSelection: enabled }))}
                disabled={loading || chatRuntimeLoading}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
            <Button type="submit" variant="primary" loading={chatRuntimeLoading}>
              Save chat runtime
            </Button>
            <Button type="button" variant="secondary" onClick={resetChatRuntimeDefaults} disabled={loading || chatRuntimeLoading}>
              Reset to default
            </Button>
          </div>
          {chatRuntimeStatus.message ? (
            <p className={`text-sm ${chatRuntimeStatus.type === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
              {chatRuntimeStatus.message}
            </p>
          ) : null}
        </form>
      </Card>

      <Card>
        <SectionIntro
          icon="schedule"
          tone="success"
          title="Usage Worker"
          description="Control automatic background usage refresh checks for supported accounts."
          eyebrow="Automation"
        />
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Enable scheduler</p>
              <p className="text-sm text-text-muted">Automatically refresh usage status in the background.</p>
            </div>
            <Toggle checked={usageWorkerForm.enabled} onChange={updateUsageWorkerEnabled} disabled={loading || usageWorkerLoading} />
          </div>
          <form onSubmit={applyUsageWorkerSettings} className="flex flex-col gap-3 border-t border-border/50 pt-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
              <div className="grid flex-1 gap-3 md:grid-cols-2 md:items-end">
                <Input
                  type="number"
                  min="15"
                  step="1"
                  label="Scheduler interval (minutes)"
                  value={usageWorkerForm.cadenceMinutes}
                  onChange={(e) => {
                    setUsageWorkerForm((prev) => ({ ...prev, cadenceMinutes: e.target.value }));
                    if (usageWorkerStatus.message) setUsageWorkerStatus({ type: "", message: "" });
                  }}
                  disabled={loading || usageWorkerLoading}
                  hint="Minimum 15 minutes. Changes are saved via the settings API."
                  className="w-full"
                />
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  label="Exhausted threshold (%)"
                  value={usageWorkerForm.exhaustedThresholdPercent}
                  onChange={(e) => {
                    setUsageWorkerForm((prev) => ({ ...prev, exhaustedThresholdPercent: e.target.value }));
                    if (usageWorkerStatus.message) setUsageWorkerStatus({ type: "", message: "" });
                  }}
                  disabled={loading || usageWorkerLoading}
                  hint="Global threshold to treat an account as exhausted."
                  className="w-full"
                />
              </div>
              <Button type="submit" variant="primary" loading={usageWorkerLoading}>
                Save usage worker settings
              </Button>
            </div>
            <div className="rounded border border-border/60 bg-[var(--color-bg)] px-3 py-2 text-sm text-text-muted">
              Current cadence: every {Math.max(15, Math.round((settings?.usageWorker?.cadenceMs || 900000) / 60000))} minutes
            </div>
          </form>
          {usageWorkerStatus.message ? (
            <p className={`border-t border-border/50 pt-2 text-sm ${usageWorkerStatus.type === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
              {usageWorkerStatus.message}
            </p>
          ) : null}
        </div>
      </Card>

      <div className="rounded-lg border border-border bg-[var(--color-bg-alt)] px-4 py-4 text-sm text-text-muted">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">System</p>
        <p className="mt-2 font-medium text-text-main">{APP_CONFIG.name} v{APP_CONFIG.version}</p>
        <p className="mt-1">Local mode keeps operational data on this machine while cloud sync follows the settings above.</p>
      </div>
    </div>
  );
}
