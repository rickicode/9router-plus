"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";

const DEFAULT_BASE_URL = "https://api.morphllm.com";

const DEFAULT_MORPH_SETTINGS = {
  baseUrl: DEFAULT_BASE_URL,
  apiKeys: [""],
  roundRobinEnabled: false,
};

const ROUTE_INVENTORY = [
  {
    localPath: "/api/morph/apply",
    upstreamTarget: "POST /v1/chat/completions",
  },
  {
    localPath: "/api/morph/compact",
    upstreamTarget: "POST /v1/compact",
  },
  {
    localPath: "/api/morph/embeddings",
    upstreamTarget: "POST /v1/embeddings",
  },
  {
    localPath: "/api/morph/rerank",
    upstreamTarget: "POST /v1/rerank",
  },
  {
    localPath: "/api/morph/warpgrep",
    upstreamTarget: "POST /v1/chat/completions",
  },
];

function normalizeMorphSettings(settings = {}) {
  const apiKeys = Array.isArray(settings.apiKeys)
    ? settings.apiKeys.map((key) => (typeof key === "string" ? key : "")).filter((key) => key.trim().length > 0)
    : [];

  return {
    baseUrl:
      typeof settings.baseUrl === "string" && settings.baseUrl.trim().length > 0
        ? settings.baseUrl
        : DEFAULT_BASE_URL,
    apiKeys: apiKeys.length > 0 ? apiKeys : [""],
    roundRobinEnabled: Boolean(settings.roundRobinEnabled),
  };
}

function buildValidationMessage(baseUrl, apiKeys) {
  if (!baseUrl.trim()) {
    return "Base URL is required.";
  }

  const normalizedApiKeys = apiKeys.map((key) => key.trim()).filter(Boolean);
  if (normalizedApiKeys.length === 0) {
    return "Add at least one Morph API key before saving.";
  }

  return "";
}

export default function MorphPageClient() {
  const [morphSettings, setMorphSettings] = useState(DEFAULT_MORPH_SETTINGS);
  const [savedMorphSettings, setSavedMorphSettings] = useState(DEFAULT_MORPH_SETTINGS);
  const [loadingMorphSettings, setLoadingMorphSettings] = useState(true);
  const [savingMorphSettings, setSavingMorphSettings] = useState(false);
  const [morphFeedback, setMorphFeedback] = useState({ type: "", message: "" });
  const [validationMessage, setValidationMessage] = useState("");

  useEffect(() => {
    loadMorphSettings();
  }, []);

  const loadMorphSettings = async () => {
    setLoadingMorphSettings(true);
    try {
      const response = await fetch("/api/settings");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to load Morph settings");
      }

      const normalized = normalizeMorphSettings(data.morph || data.settings?.morph);
      setSavedMorphSettings(normalized);
      setMorphSettings(normalized);
    } catch (error) {
      console.error("Failed to load Morph settings:", error);
      setMorphFeedback({ type: "error", message: error.message || "Failed to load Morph settings" });
      setSavedMorphSettings(DEFAULT_MORPH_SETTINGS);
      setMorphSettings(DEFAULT_MORPH_SETTINGS);
    } finally {
      setLoadingMorphSettings(false);
    }
  };

  const handleFieldChange = (field, value) => {
    setMorphSettings((current) => ({
      ...current,
      [field]: value,
    }));
    setValidationMessage("");
  };

  const handleApiKeyChange = (index, value) => {
    setMorphSettings((current) => ({
      ...current,
      apiKeys: current.apiKeys.map((key, keyIndex) => (keyIndex === index ? value : key)),
    }));
    setValidationMessage("");
  };

  const handleAddApiKey = () => {
    setMorphSettings((current) => ({
      ...current,
      apiKeys: [...current.apiKeys, ""],
    }));
    setValidationMessage("");
  };

  const handleRemoveApiKey = (index) => {
    setMorphSettings((current) => ({
      ...current,
      apiKeys: current.apiKeys.filter((_, keyIndex) => keyIndex !== index),
    }));
    setValidationMessage("");
  };

  const handleSaveMorphSettings = async () => {
    const normalizedApiKeys = morphSettings.apiKeys.map((key) => key.trim()).filter(Boolean);
    const nextValidationMessage = buildValidationMessage(morphSettings.baseUrl, morphSettings.apiKeys);

    if (nextValidationMessage) {
      setValidationMessage(nextValidationMessage);
      setMorphFeedback({ type: "", message: "" });
      return;
    }

    setSavingMorphSettings(true);
    setMorphFeedback({ type: "", message: "" });

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          morph: {
            baseUrl: morphSettings.baseUrl.trim(),
            apiKeys: normalizedApiKeys,
            roundRobinEnabled: morphSettings.roundRobinEnabled,
          },
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Failed to save Morph settings");
      }

      const normalized = normalizeMorphSettings(data.settings?.morph || data.morph || morphSettings);
      setSavedMorphSettings(normalized);
      setMorphSettings(normalized);
      setValidationMessage("");
      setMorphFeedback({ type: "success", message: "Morph settings saved." });
    } catch (error) {
      setMorphFeedback({ type: "error", message: error.message || "Failed to save Morph settings" });
    } finally {
      setSavingMorphSettings(false);
    }
  };

  const hasUnsavedChanges = useMemo(() => {
    const normalizeForCompare = (value) => ({
      baseUrl: value.baseUrl.trim(),
      apiKeys: value.apiKeys.map((key) => key.trim()),
      roundRobinEnabled: Boolean(value.roundRobinEnabled),
    });

    return JSON.stringify(normalizeForCompare(morphSettings)) !== JSON.stringify(normalizeForCompare(savedMorphSettings));
  }, [morphSettings, savedMorphSettings]);

  const feedbackToneClassName =
    morphFeedback.type === "error"
      ? "border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-text-main)]"
      : "border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-text-main)]";

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          href="/dashboard/settings"
          className="inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-primary"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          Back to Settings
        </Link>
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-text-main)]">Morph</h1>
          <p className="max-w-3xl text-sm leading-6 text-[var(--color-text-muted)]">
            Configure the dedicated Morph proxy bundle separately from provider selection so the five capability
            routes keep their raw upstream transport behavior.
          </p>
        </div>
      </div>

      <Card>
        <Card.Section className="flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/10 px-4 py-3">
            <span className="material-symbols-outlined text-[20px] text-[var(--color-accent)]">route</span>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-[var(--color-text-main)]">Proxy-only integration</p>
              <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                Morph stays outside the standard provider registry. Save the upstream base URL, key order, and
                rotation behavior here without mixing it into model routing UI.
              </p>
            </div>
          </div>
        </Card.Section>

        <Card.Section className="flex flex-col gap-6 border-t border-[var(--color-border)]">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold tracking-tight text-[var(--color-text-main)]">Morph settings</h2>
            <p className="text-sm leading-6 text-[var(--color-text-muted)]">
              The settings API stores Morph under its own namespace so this page can load and save only
              `settings.morph`.
            </p>
          </div>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-[var(--color-text-main)]">Base URL</span>
            <input
              type="text"
              value={morphSettings.baseUrl}
              onChange={(event) => handleFieldChange("baseUrl", event.target.value)}
              placeholder="https://api.morphllm.com"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-sm text-[var(--color-text-main)] outline-none transition-colors focus:border-[var(--color-primary)]"
            />
          </label>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium text-[var(--color-text-main)]">API keys</h3>
                <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                  Keep keys ordered so operators can control the exact primary/failover sequence.
                </p>
              </div>
              <Button type="button" variant="secondary" size="sm" icon="add" onClick={handleAddApiKey}>
                Add key
              </Button>
            </div>

            <ol className="flex list-decimal flex-col gap-3 pl-5">
              {morphSettings.apiKeys.map((apiKey, index) => (
                <li key={`morph-api-key-${index}`} className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(event) => handleApiKeyChange(index, event.target.value)}
                      placeholder={`Morph API key ${index}`}
                      className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)] outline-none transition-colors focus:border-[var(--color-primary)]"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon="delete"
                      onClick={() => handleRemoveApiKey(index)}
                    >
                      Remove key
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <label className="flex items-start gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-3">
            <input
              type="checkbox"
              checked={morphSettings.roundRobinEnabled}
              onChange={(event) => handleFieldChange("roundRobinEnabled", event.target.checked)}
              className="mt-1 h-4 w-4 rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
            />
            <span className="flex flex-col gap-1">
              <span className="text-sm font-medium text-[var(--color-text-main)]">Round-robin keys</span>
              <span className="text-sm leading-6 text-[var(--color-text-muted)]">
                When round-robin is off, key 0 is primary and later keys are failover-only.
              </span>
            </span>
          </label>

          <div className="flex flex-col gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium text-[var(--color-text-main)]">Route inventory</h3>
              <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                Each local Morph endpoint forwards directly to its fixed upstream capability route.
              </p>
            </div>

            <div className="grid gap-3">
              {ROUTE_INVENTORY.map((route) => (
                <div
                  key={route.localPath}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3"
                >
                  <p className="font-mono text-sm text-[var(--color-text-main)]">{route.localPath}</p>
                  <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">{route.upstreamTarget}</p>
                </div>
              ))}
            </div>
          </div>

          {validationMessage ? (
            <div className="rounded border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-text-main)]">
              {validationMessage}
            </div>
          ) : null}

          {morphFeedback.message ? (
            <div className={`rounded border px-4 py-3 text-sm ${feedbackToneClassName}`}>{morphFeedback.message}</div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={handleSaveMorphSettings}
              loading={savingMorphSettings}
              disabled={loadingMorphSettings || savingMorphSettings || !hasUnsavedChanges}
            >
              Save Morph settings
            </Button>
            <span className="text-sm text-[var(--color-text-muted)]">
              {loadingMorphSettings ? "Loading Morph settings..." : hasUnsavedChanges ? "Unsaved changes" : "All changes saved"}
            </span>
          </div>
        </Card.Section>
      </Card>
    </div>
  );
}
