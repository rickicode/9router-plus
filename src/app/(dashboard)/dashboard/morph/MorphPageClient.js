"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { fetchJson, patchDashboardQuery, useDashboardQuery } from "@/shared/hooks";

const DEFAULT_BASE_URL = "https://api.morphllm.com";
const PERIOD_OPTIONS = [
  { value: "24h", label: "24H" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];
const REQUEST_LOG_PAGE_SIZE = 10;
const REQUEST_LOG_AUTO_REFRESH_MS = 5000;
const EMAIL_BREAKDOWN_PAGE_SIZE = 8;

const EMPTY_MORPH_KEY = {
  email: "",
  key: "",
  status: "inactive",
  isExhausted: false,
  lastCheckedAt: null,
  lastError: "",
};

const DEFAULT_MORPH_SETTINGS = {
  baseUrl: DEFAULT_BASE_URL,
  apiKeys: [],
  roundRobinEnabled: false,
};

const EMPTY_USAGE_STATS = {
  totalRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCredits: 0,
  totalRequestsLifetime: 0,
  byCapability: {},
  byModel: {},
  byApiKey: {},
  byEntrypoint: {},
  recentRequests: [],
};

const MORPH_ROUTE_EXAMPLES = [
  {
    path: "/morphllm/v1/chat/completions",
    method: "POST",
    target: "/v1/chat/completions",
  },
  {
    path: "/morphllm/v1/compact",
    method: "POST",
    target: "/v1/compact",
  },
  {
    path: "/morphllm/v1/embeddings",
    method: "POST",
    target: "/v1/embeddings",
  },
  {
    path: "/morphllm/v1/rerank",
    method: "POST",
    target: "/v1/rerank",
  },
  {
    path: "/morphllm/v1/models",
    method: "GET",
    target: "/v1/models",
  },
];

function normalizeMorphSettings(settings = {}) {
  const apiKeys = Array.isArray(settings.apiKeys)
    ? settings.apiKeys
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
          const email = typeof entry.email === "string" ? entry.email.trim().toLowerCase() : "";
          const key = typeof entry.key === "string" ? entry.key : "";
          if (!email || !key.trim()) return null;
          return {
            ...EMPTY_MORPH_KEY,
            ...entry,
            email,
            key,
          };
        })
        .filter(Boolean)
    : [];

  return {
    baseUrl:
      typeof settings.baseUrl === "string" && settings.baseUrl.trim().length > 0
        ? settings.baseUrl
        : DEFAULT_BASE_URL,
    apiKeys,
    roundRobinEnabled: Boolean(settings.roundRobinEnabled),
  };
}

function buildValidationMessage(apiKeys) {
  if (apiKeys.length === 0) {
    return "Add at least one Morph API key.";
  }

  return "";
}

function normalizeForCompare(value) {
  return {
    baseUrl: value.baseUrl.trim(),
    apiKeys: value.apiKeys.map((entry) => ({
      email: entry.email,
      key: entry.key.trim(),
      status: entry.status || "inactive",
      isExhausted: entry.isExhausted === true,
      lastCheckedAt: entry.lastCheckedAt || null,
      lastError: entry.lastError || "",
    })),
    roundRobinEnabled: Boolean(value.roundRobinEnabled),
  };
}

function parseBulkMorphApiKeys(text) {
  const byEmail = new Map();
  const lines = String(text || "").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [rawEmail, ...rest] = trimmed.split("|");
    const email = (rawEmail || "").trim().toLowerCase();
    const key = rest.join("|").trim();
    if (!email || !key) {
      throw new Error("Each line must use the format email|apikey");
    }

    byEmail.set(email, {
      ...EMPTY_MORPH_KEY,
      email,
      key,
    });
  }

  return Array.from(byEmail.values());
}

function mergeMorphApiKeys(currentKeys, importedKeys) {
  const merged = new Map(currentKeys.map((entry) => [entry.email, entry]));
  for (const entry of importedKeys) {
    const existing = merged.get(entry.email);
    merged.set(entry.email, {
      ...EMPTY_MORPH_KEY,
      ...existing,
      ...entry,
      status: "inactive",
      isExhausted: false,
      lastCheckedAt: null,
      lastError: "",
    });
  }
  return Array.from(merged.values());
}

function formatMorphKeyStatus(entry) {
  if (entry.status === "active") return "Active";
  if (entry.status === "exhausted") return "Exhausted";
  if (entry.status === "inactive") return "Invalid";
  return "Inactive";
}

function getMorphKeyStatusTone(entry) {
  if (entry.status === "active") return "text-[var(--color-success)]";
  if (entry.status === "exhausted") return "text-[var(--color-warning)]";
  if (entry.status === "inactive") return "text-[var(--color-danger)]";
  return "text-[var(--color-text-muted)]";
}

function fmtNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function fmtCredits(value) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function formatStatus(status) {
  return status === "ok" ? "OK" : "FAILED";
}

function formatLocalDateTime(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function formatCapabilityLabel(value) {
  if (!value) return "All capabilities";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function sortUsageEntries(entries = []) {
  return [...entries].sort(([, left], [, right]) => {
    const requestDiff = (right?.requests || 0) - (left?.requests || 0);
    if (requestDiff !== 0) return requestDiff;
    return String(left?.capability || left?.model || left?.email || left?.apiKeyLabel || left?.entrypoint || "").localeCompare(
      String(right?.capability || right?.model || right?.email || right?.apiKeyLabel || right?.entrypoint || "")
    );
  });
}

function UsageMetricCard({ label, value, hint }) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-[var(--color-text-main)]">{value}</p>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">{hint}</p>
    </Card>
  );
}

function buildMorphBrowserBaseUrl() {
  if (typeof window === "undefined") {
    return "/morphllm";
  }

  return `${window.location.origin}/morphllm`;
}

export default function MorphPageClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl === "usage" ? "usage" : "settings";
  const morphSettingsQuery = useDashboardQuery("settings", () => fetchJson("/api/settings"));
  const [savingMorphSettings, setSavingMorphSettings] = useState(false);
  const [morphFeedback, setMorphFeedback] = useState({ type: "", message: "" });
  const [validationMessage, setValidationMessage] = useState("");
  const [usagePeriod, setUsagePeriod] = useState("7d");
  const usageKey = `morph-usage-${usagePeriod}`;
  const morphUsageQuery = useDashboardQuery(
    usageKey,
    async () => {
      const [statsData, requestsData] = await Promise.all([
        fetchJson(`/api/morph/usage/stats?period=${usagePeriod}`),
        fetchJson("/api/morph/usage/requests?limit=200"),
      ]);
      return {
        usageStats: { ...EMPTY_USAGE_STATS, ...statsData },
        requestLogs: Array.isArray(requestsData) ? requestsData : [],
      };
    },
    {
      enabled: activeTab === "usage",
      initialData: {
        usageStats: EMPTY_USAGE_STATS,
        requestLogs: [],
      },
    }
  );
  const usageStats = morphUsageQuery.data?.usageStats || EMPTY_USAGE_STATS;
  const usageLoading = morphUsageQuery.isLoading;
  const usageLoadError = morphUsageQuery.error?.message || "";
  const requestLogs = useMemo(() => morphUsageQuery.data?.requestLogs || [], [morphUsageQuery.data]);
  const [requestCapabilityFilter, setRequestCapabilityFilter] = useState("all");
  const [requestPage, setRequestPage] = useState(1);
  const [requestAutoRefresh, setRequestAutoRefresh] = useState(true);
  const [emailBreakdownSearch, setEmailBreakdownSearch] = useState("");
  const [emailBreakdownPage, setEmailBreakdownPage] = useState(1);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkImportValue, setBulkImportValue] = useState("");
  const [bulkImportSaving, setBulkImportSaving] = useState(false);
  const [testingKeyEmail, setTestingKeyEmail] = useState("");
  const browserMorphBaseUrl = useMemo(() => buildMorphBrowserBaseUrl(), []);
  const morphUsageRefresh = morphUsageQuery.refresh;
  const loadMorphUsage = () => void morphUsageRefresh();

  const settingsPayload = morphSettingsQuery.data?.morph || morphSettingsQuery.data?.settings?.morph;
  const loadingMorphSettings = morphSettingsQuery.isLoading && !morphSettingsQuery.data;
  const savedMorphSettings = useMemo(
    () => normalizeMorphSettings(settingsPayload || DEFAULT_MORPH_SETTINGS),
    [settingsPayload]
  );
  const savedMorphSettingsSnapshot = useMemo(
    () => JSON.stringify(normalizeForCompare(savedMorphSettings)),
    [savedMorphSettings]
  );
  const [draftMorphSettings, setDraftMorphSettings] = useState(null);
  const draftMorphSettingsSnapshot = useMemo(
    () => (draftMorphSettings ? JSON.stringify(normalizeForCompare(draftMorphSettings)) : null),
    [draftMorphSettings]
  );
  const hasDraftChanges = draftMorphSettingsSnapshot !== null && draftMorphSettingsSnapshot !== savedMorphSettingsSnapshot;
  const morphSettings = hasDraftChanges ? draftMorphSettings : savedMorphSettings;

  useEffect(() => {
    if (activeTab !== "usage" || !requestAutoRefresh) {
      return undefined;
    }

    const intervalId = setInterval(() => {
      void morphUsageRefresh();
    }, REQUEST_LOG_AUTO_REFRESH_MS);

    return () => clearInterval(intervalId);
  }, [activeTab, requestAutoRefresh, usagePeriod, morphUsageRefresh]);

  const persistMorphSettings = async (nextSettings) => {
    const nextValidationMessage = buildValidationMessage(nextSettings.apiKeys);

    if (nextValidationMessage) {
      setValidationMessage(nextValidationMessage);
      setMorphFeedback({ type: "", message: "" });
      return false;
    }

    if (JSON.stringify(normalizeForCompare(nextSettings)) === savedMorphSettingsSnapshot) {
      setValidationMessage("");
      return true;
    }

    setSavingMorphSettings(true);
    setMorphFeedback({ type: "info", message: "Saving Morph settings..." });

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          morph: {
            baseUrl: nextSettings.baseUrl.trim(),
            apiKeys: nextSettings.apiKeys.map((entry) => ({
              email: entry.email.trim().toLowerCase(),
              key: entry.key,
              status: entry.status || "inactive",
              isExhausted: entry.isExhausted === true,
              lastCheckedAt: entry.lastCheckedAt || null,
              lastError: entry.lastError || "",
            })),
            roundRobinEnabled: nextSettings.roundRobinEnabled,
          },
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Failed to save Morph settings");
      }

      const normalized = normalizeMorphSettings(data.settings?.morph || data.morph || nextSettings);
      setDraftMorphSettings(null);
      patchDashboardQuery("settings", (current) => ({
        ...(current || {}),
        ...(data || {}),
        morph: normalized,
      }));
      await morphSettingsQuery.refresh();
      setValidationMessage("");
      setMorphFeedback({ type: "success", message: "Morph settings saved." });
      return true;
    } catch (error) {
      setMorphFeedback({ type: "error", message: error.message || "Failed to save Morph settings" });
      return false;
    } finally {
      setSavingMorphSettings(false);
    }
  };

  const handleAddApiKey = () => {
    setBulkImportValue("");
    setBulkImportOpen(true);
  };

  const handleSaveBulkImport = async () => {
    setBulkImportSaving(true);
    try {
      const importedKeys = parseBulkMorphApiKeys(bulkImportValue);
      if (importedKeys.length === 0) {
        throw new Error("Add at least one email|apikey row.");
      }

      const nextSettings = {
        ...morphSettings,
        apiKeys: mergeMorphApiKeys(morphSettings.apiKeys, importedKeys),
      };

      setDraftMorphSettings(nextSettings);
      setValidationMessage("");
      const saved = await persistMorphSettings(nextSettings);
      if (saved) {
        setBulkImportOpen(false);
        setBulkImportValue("");
      }
    } catch (error) {
      setMorphFeedback({ type: "error", message: error.message || "Failed to import Morph API keys" });
    } finally {
      setBulkImportSaving(false);
    }
  };

  const handleRemoveApiKey = async (index) => {
    const nextApiKeys = morphSettings.apiKeys.filter((_, keyIndex) => keyIndex !== index);
    const nextSettings = {
      ...morphSettings,
      apiKeys: nextApiKeys,
    };

    setDraftMorphSettings(nextSettings);
    setValidationMessage("");
    await persistMorphSettings(nextSettings);
  };

  const handleTestApiKey = async (email) => {
    setTestingKeyEmail(email);
    setMorphFeedback({ type: "info", message: `Testing ${email}...` });
    try {
      const response = await fetch("/api/morph/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json().catch(() => ({}));
      await morphSettingsQuery.refresh();

      if (!response.ok) {
        throw new Error(data.error || `${email} is not active`);
      }

      setMorphFeedback({ type: "success", message: `${email} is active.` });
    } catch (error) {
      setMorphFeedback({ type: "error", message: error.message || `Failed to test ${email}` });
    } finally {
      setTestingKeyEmail("");
    }
  };

  const handleTestAllApiKeys = async () => {
    if (morphSettings.apiKeys.length === 0) return;

    setTestingKeyEmail("__all__");
    setMorphFeedback({ type: "info", message: `Testing ${morphSettings.apiKeys.length} Morph key(s)...` });

    let successCount = 0;
    let failureCount = 0;

    for (const apiKey of morphSettings.apiKeys) {
      try {
        const response = await fetch("/api/morph/test-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: apiKey.email }),
        });

        if (response.ok) {
          successCount += 1;
        } else {
          failureCount += 1;
        }
      } catch {
        failureCount += 1;
      }
    }

    await morphSettingsQuery.refresh();
    setTestingKeyEmail("");

    if (failureCount === 0) {
      setMorphFeedback({ type: "success", message: `All ${successCount} Morph key(s) are active.` });
      return;
    }

    if (successCount === 0) {
      setMorphFeedback({ type: "error", message: `All ${failureCount} Morph key(s) failed testing.` });
      return;
    }

    setMorphFeedback({
      type: "info",
      message: `${successCount} Morph key(s) active, ${failureCount} failed.`,
    });
  };

  const handleRoundRobinChange = async (checked) => {
    const nextSettings = {
      ...morphSettings,
      roundRobinEnabled: checked,
    };

    setDraftMorphSettings(nextSettings);
    setValidationMessage("");
    await persistMorphSettings(nextSettings);
  };

  const hasUnsavedChanges = hasDraftChanges;

  const capabilityFilterOptions = useMemo(() => {
    const capabilityKeys = Object.keys(usageStats.byCapability || {});
    return ["all", ...capabilityKeys];
  }, [usageStats.byCapability]);

  const filteredRequestLogs = useMemo(() => {
    if (requestCapabilityFilter === "all") {
      return requestLogs;
    }

    return requestLogs.filter((entry) => entry.capability === requestCapabilityFilter);
  }, [requestCapabilityFilter, requestLogs]);

  const latestEntrypointByApiKey = useMemo(() => {
    const map = new Map();
    for (const entry of requestLogs) {
      const key = entry.apiKeyLabel || "Unknown email";
      if (!map.has(key) && entry.entrypoint) {
        map.set(key, entry.entrypoint);
      }
    }
    return map;
  }, [requestLogs]);

  const sortedEmailUsageEntries = useMemo(() => {
    return sortUsageEntries(Object.entries(usageStats.byApiKey || {}));
  }, [usageStats.byApiKey]);

  const filteredEmailUsageEntries = useMemo(() => {
    const search = emailBreakdownSearch.trim().toLowerCase();
    if (!search) {
      return sortedEmailUsageEntries;
    }

    return sortedEmailUsageEntries.filter(([key, value]) => {
      const label = String(value?.apiKeyLabel || key || "").toLowerCase();
      const searchValues = [
        label,
        String(value?.inputTokens ?? "").toLowerCase(),
        String(value?.outputTokens ?? "").toLowerCase(),
        String(value?.requests ?? "").toLowerCase(),
        String(value?.credits ?? "").toLowerCase(),
        fmtNumber(value?.inputTokens).toLowerCase(),
        fmtNumber(value?.outputTokens).toLowerCase(),
        fmtNumber(value?.requests).toLowerCase(),
        fmtCredits(value?.credits).toLowerCase(),
      ];
      return searchValues.some((entry) => entry.includes(search));
    });
  }, [emailBreakdownSearch, sortedEmailUsageEntries]);

  const totalEmailBreakdownPages = Math.max(1, Math.ceil(filteredEmailUsageEntries.length / EMAIL_BREAKDOWN_PAGE_SIZE));
  const currentEmailBreakdownPage = Math.min(emailBreakdownPage, totalEmailBreakdownPages);

  const paginatedEmailUsageEntries = useMemo(() => {
    const startIndex = (currentEmailBreakdownPage - 1) * EMAIL_BREAKDOWN_PAGE_SIZE;
    return filteredEmailUsageEntries.slice(startIndex, startIndex + EMAIL_BREAKDOWN_PAGE_SIZE);
  }, [currentEmailBreakdownPage, filteredEmailUsageEntries]);

  const handleEmailBreakdownSearchChange = (value) => {
    setEmailBreakdownSearch(value);
    setEmailBreakdownPage(1);
  };

  const totalRequestPages = Math.max(1, Math.ceil(filteredRequestLogs.length / REQUEST_LOG_PAGE_SIZE));
  const currentRequestPage = Math.min(requestPage, totalRequestPages);

  const paginatedRequestLogs = useMemo(() => {
    const startIndex = (currentRequestPage - 1) * REQUEST_LOG_PAGE_SIZE;
    return filteredRequestLogs.slice(startIndex, startIndex + REQUEST_LOG_PAGE_SIZE);
  }, [currentRequestPage, filteredRequestLogs]);

  const handleRequestCapabilityFilterChange = (value) => {
    setRequestCapabilityFilter(value);
    setRequestPage(1);
  };

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    if (value === "usage") {
      params.set("tab", "usage");
    } else {
      params.delete("tab");
    }
    const nextQuery = params.toString();
    router.push(nextQuery ? `/dashboard/morph?${nextQuery}` : "/dashboard/morph", { scroll: false });
  };

  const feedbackToneClassName =
    morphFeedback.type === "error"
      ? "border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-text-main)]"
      : morphFeedback.type === "success"
        ? "border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-text-main)]"
        : "border-[var(--color-primary)]/30 bg-[var(--color-primary)]/10 text-[var(--color-text-main)]";

  const statusText = loadingMorphSettings
    ? "Loading Morph settings..."
    : savingMorphSettings
      ? "Saving changes..."
      : hasUnsavedChanges
        ? "Changes pending save"
        : "All changes saved";

  return (
    <div className="flex w-full max-w-6xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-text-main)]">Morph</h1>
          <p className="max-w-4xl text-sm leading-6 text-[var(--color-text-muted)]">
            Manage Morph key rotation and use the browser-specific base URL below to call the local 9Router Morph proxy.
          </p>
        </div>
      </div>

      <SegmentedControl
        options={[
          { value: "settings", label: "Settings" },
          { value: "usage", label: "Usage" },
        ]}
        value={activeTab}
        onChange={handleTabChange}
        activeClassName="border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
      />

      {activeTab === "settings" ? (
        <Card className="overflow-hidden" padding="none">
          <Card.Section className="flex flex-col gap-4 p-6">
            <div className="flex flex-col gap-4 rounded border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/10 px-4 py-4">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-[20px] text-[var(--color-accent)]">route</span>
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-[var(--color-text-main)]">Browser Morph base URL</p>
                  <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                    Follow the current browser origin and append `/morphllm` when pointing clients at the local 9Router Morph proxy.
                  </p>
                </div>
              </div>

              <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
                <p className="text-xs uppercase tracking-[0.08em] text-[var(--color-text-muted)]">Base URL</p>
                <p className="mt-2 break-all font-mono text-sm text-[var(--color-text-main)]">{browserMorphBaseUrl}</p>
              </div>

              <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                Recommended routes mirror Morph upstream paths exactly, with only the `/morphllm` prefix added.
              </p>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {MORPH_ROUTE_EXAMPLES.map((route) => (
                  <div
                    key={route.path}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-3"
                  >
                    <p className="font-mono text-sm text-[var(--color-text-main)]">{route.path}</p>
                    <p className="mt-2 font-mono text-xs uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                      {route.method} mirrors {route.target}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </Card.Section>

          <Card.Section className="flex flex-col gap-6 border-t border-[var(--color-border)] p-6">
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold tracking-tight text-[var(--color-text-main)]">Morph settings</h2>
              <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                Bulk import Morph keys with `email|apikey`, validate them immediately, and keep invalid or exhausted keys out of rotation automatically.
              </p>
            </div>

            <div className="flex flex-col gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium text-[var(--color-text-main)]">API keys</h3>
                  <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                    Duplicate emails replace older keys automatically. Invalid and exhausted keys are skipped until they test active again.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    icon="health_and_safety"
                    onClick={handleTestAllApiKeys}
                    loading={testingKeyEmail === "__all__"}
                    disabled={loadingMorphSettings || savingMorphSettings || morphSettings.apiKeys.length === 0}
                  >
                    Test all keys
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    icon="add"
                    className="min-w-[132px]"
                    onClick={handleAddApiKey}
                    disabled={loadingMorphSettings || savingMorphSettings}
                  >
                    Add key
                  </Button>
                </div>
              </div>

              <ol className="flex list-decimal flex-col gap-3 pl-5">
                {morphSettings.apiKeys.map((apiKey, index) => (
                  <li
                    key={apiKey.email || `morph-api-key-${index}`}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3"
                  >
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="truncate font-mono text-sm text-[var(--color-text-main)]">{apiKey.email}</p>
                          <p className="text-xs text-[var(--color-text-muted)]">
                            {apiKey.lastCheckedAt ? `Last checked ${formatLocalDateTime(apiKey.lastCheckedAt)}` : "Checking key status..."}
                          </p>
                        </div>
                        <span className={`text-xs font-medium uppercase tracking-[0.08em] ${getMorphKeyStatusTone(apiKey)}`}>
                          {formatMorphKeyStatus(apiKey)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 font-mono text-xs text-[var(--color-text-muted)]">
                          {apiKey.key.length > 10 ? `${apiKey.key.slice(0, 6)}...${apiKey.key.slice(-4)}` : apiKey.key}
                        </div>
                        <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            icon="health_and_safety"
                            onClick={() => handleTestApiKey(apiKey.email)}
                            loading={testingKeyEmail === apiKey.email}
                            disabled={loadingMorphSettings || savingMorphSettings || testingKeyEmail === "__all__"}
                          >
                            Test key
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            icon="delete"
                            onClick={() => handleRemoveApiKey(index)}
                            disabled={loadingMorphSettings || savingMorphSettings || testingKeyEmail === apiKey.email || testingKeyEmail === "__all__"}
                          >
                            Remove key
                          </Button>
                        </div>
                      </div>
                      {apiKey.lastError ? (
                        <p className="text-xs text-[var(--color-warning)]">{apiKey.lastError}</p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <label className="flex items-start gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-4 py-3">
              <input
                type="checkbox"
                checked={morphSettings.roundRobinEnabled}
                onChange={(event) => handleRoundRobinChange(event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
              />
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium text-[var(--color-text-main)]">Round-robin keys</span>
                <span className="text-sm leading-6 text-[var(--color-text-muted)]">
                  When round-robin is off, the first active email stays primary and later emails are failover-only.
                </span>
              </span>
            </label>

            {validationMessage ? (
              <div className="rounded border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-text-main)]">
                {validationMessage}
              </div>
            ) : null}

            {morphFeedback.message ? (
              <div className={`rounded border px-4 py-3 text-sm ${feedbackToneClassName}`}>{morphFeedback.message}</div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-4">
              <span className="text-sm text-[var(--color-text-muted)]">{statusText}</span>
            </div>
          </Card.Section>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          <Card
            className="px-5 py-3"
            title="Isolated Morph usage"
            subtitle="Morph request logs stay isolated from the global provider usage dashboard and cover direct `/morphllm/*` traffic only."
            icon="monitoring"
          />

          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold tracking-tight text-[var(--color-text-main)]">Morph usage</h2>
              <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                Review Morph-only requests, token flow, and estimated credits.
              </p>
            </div>
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
              <div className="max-w-full overflow-x-auto">
                <SegmentedControl options={PERIOD_OPTIONS} value={usagePeriod} onChange={setUsagePeriod} size="sm" />
              </div>
              <Button type="button" variant="secondary" size="md" className="h-8" icon="refresh" onClick={loadMorphUsage}>
                Refresh
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-[var(--color-text-main)]">Overview</h3>
              <span className="text-xs text-[var(--color-text-muted)]">Official Morph pricing basis</span>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <UsageMetricCard label="Requests" value={fmtNumber(usageStats.totalRequests)} hint={`${usagePeriod} window`} />
              <UsageMetricCard label="Input tokens" value={fmtNumber(usageStats.totalInputTokens)} hint="Morph-only ingress" />
              <UsageMetricCard label="Output tokens" value={fmtNumber(usageStats.totalOutputTokens)} hint="Morph-only egress" />
              <UsageMetricCard label="Estimated credits" value={fmtCredits(usageStats.totalCredits)} hint="Official Morph pricing basis" />
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="p-4" title="By capability" subtitle={`${fmtNumber(Object.keys(usageStats.byCapability || {}).length)} groups`}>
              <div className="overflow-x-auto">
                <table className="min-w-[320px] w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                      <th className="py-2">Capability</th>
                      <th className="py-2 text-right">Req</th>
                      <th className="py-2 text-right">Credits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortUsageEntries(Object.entries(usageStats.byCapability || {})).map(([key, value]) => (
                      <tr key={key} className="border-b border-[var(--color-border)]/60">
                        <td className="py-2 font-mono text-[var(--color-text-main)]">{value.capability || key}</td>
                        <td className="py-2 text-right text-[var(--color-text-muted)]">{fmtNumber(value.requests)}</td>
                        <td className="py-2 text-right text-[var(--color-text-muted)]">{fmtCredits(value.credits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="p-4" title="By model" subtitle="Morph billed models">
              <div className="overflow-x-auto">
                <table className="min-w-[320px] w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                      <th className="py-2">Model</th>
                      <th className="py-2 text-right">In</th>
                      <th className="py-2 text-right">Out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortUsageEntries(Object.entries(usageStats.byModel || {})).map(([key, value]) => (
                      <tr key={key} className="border-b border-[var(--color-border)]/60">
                        <td className="py-2 font-mono text-[var(--color-text-main)]">{value.model || key}</td>
                        <td className="py-2 text-right text-[var(--color-text-muted)]">{fmtNumber(value.inputTokens)}</td>
                        <td className="py-2 text-right text-[var(--color-text-muted)]">{fmtNumber(value.outputTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="p-4" title="By entrypoint" subtitle="Direct Morph client endpoints">
              <div className="overflow-x-auto">
                <table className="min-w-[320px] w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                      <th className="py-2">Entrypoint</th>
                      <th className="py-2 text-right">Req</th>
                      <th className="py-2 text-right">Credits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortUsageEntries(Object.entries(usageStats.byEntrypoint || {})).map(([key, value]) => (
                      <tr key={key} className="border-b border-[var(--color-border)]/60">
                        <td className="py-2 font-mono text-[var(--color-text-main)]">{value.entrypoint || key}</td>
                        <td className="py-2 text-right text-[var(--color-text-muted)]">{fmtNumber(value.requests)}</td>
                        <td className="py-2 text-right text-[var(--color-text-muted)]">{fmtCredits(value.credits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          <Card className="p-4" title="By email" subtitle="Serving-key ownership across token flow, requests, and credits">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative w-full sm:max-w-[320px]">
                  <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-[var(--color-text-muted)]">
                    search
                  </span>
                  <input
                    type="text"
                    value={emailBreakdownSearch}
                    onChange={(event) => handleEmailBreakdownSearchChange(event.target.value)}
                    placeholder="Search email or token usage"
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] py-2 pl-10 pr-3 text-sm text-[var(--color-text-main)] outline-none transition-colors focus:border-[var(--color-primary)]"
                  />
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  Showing {fmtNumber(filteredEmailUsageEntries.length)} group{filteredEmailUsageEntries.length === 1 ? "" : "s"}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-[760px] w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                      <th className="py-2">Email</th>
                      <th className="py-2 text-right">In</th>
                      <th className="py-2 text-right">Out</th>
                      <th className="py-2 text-right">Req</th>
                      <th className="py-2 text-right">Credits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedEmailUsageEntries.map(([key, value]) => (
                      <tr key={key} className="border-b border-[var(--color-border)]/60">
                        <td className="py-2 text-[var(--color-text-main)]">
                          <div className="flex flex-col gap-1">
                            <span className="font-mono">{value.apiKeyLabel || key}</span>
                            <span className="font-mono text-xs text-[var(--color-text-muted)]">{latestEntrypointByApiKey.get(value.apiKeyLabel || key) || "-"}</span>
                          </div>
                        </td>
                        <td className="py-2 text-right text-[var(--color-text-muted)]">{fmtNumber(value.inputTokens)}</td>
                        <td className="py-2 text-right text-[var(--color-text-muted)]">{fmtNumber(value.outputTokens)}</td>
                        <td className="py-2 text-right text-[var(--color-text-muted)]">{fmtNumber(value.requests)}</td>
                        <td className="py-2 text-right text-[var(--color-text-muted)]">{fmtCredits(value.credits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {filteredEmailUsageEntries.length > 0 ? (
                <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm text-[var(--color-text-muted)]">
                    Page {fmtNumber(currentEmailBreakdownPage)} of {fmtNumber(totalEmailBreakdownPages)}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setEmailBreakdownPage((current) => Math.max(1, current - 1))}
                      disabled={currentEmailBreakdownPage === 1}
                    >
                      Previous
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setEmailBreakdownPage((current) => Math.min(totalEmailBreakdownPages, current + 1))}
                      disabled={currentEmailBreakdownPage === totalEmailBreakdownPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </Card>

          <Card
            className="overflow-hidden"
            padding="none"
          >
            <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="max-w-3xl">
                <h3 className="text-[var(--color-text-main)] font-semibold">Request logs</h3>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  Every Morph request is recorded separately for direct `/morphllm/*` traffic.
                </p>
              </div>
              <div className="flex shrink-0 items-start sm:justify-end">
                <span className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-2.5 py-1 text-xs text-[var(--color-text-muted)]">
                  Lifetime: {fmtNumber(usageStats.totalRequestsLifetime)}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-[var(--color-border)] px-5 py-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex flex-col gap-2 sm:max-w-[220px]">
                <label className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Capability filter
                </label>
                <select
                  value={requestCapabilityFilter}
                  onChange={(event) => handleRequestCapabilityFilterChange(event.target.value)}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-2 text-sm text-[var(--color-text-main)] outline-none transition-colors focus:border-[var(--color-primary)]"
                >
                  {capabilityFilterOptions.map((option) => (
                    <option key={option} value={option}>
                      {option === "all" ? "All capabilities" : formatCapabilityLabel(option)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-3 sm:items-end">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-muted)]">
                  <input
                    type="checkbox"
                    checked={requestAutoRefresh}
                    onChange={(event) => setRequestAutoRefresh(event.target.checked)}
                    className="h-4 w-4 rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                  />
                  Auto refresh (5s)
                </label>
                <div className="text-xs text-[var(--color-text-muted)]">
                  Showing {fmtNumber(filteredRequestLogs.length)} request{filteredRequestLogs.length === 1 ? "" : "s"}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto border-t border-[var(--color-border)]">
              {usageLoading && filteredRequestLogs.length === 0 ? (
                <div className="px-5 py-7 text-sm text-[var(--color-text-muted)]">Loading Morph usage...</div>
              ) : usageLoadError && filteredRequestLogs.length === 0 ? (
                <div className="px-5 py-7 text-sm text-[var(--color-danger)]">{usageLoadError}</div>
              ) : filteredRequestLogs.length === 0 ? (
                <div className="px-5 py-7 text-sm text-[var(--color-text-muted)]">No Morph requests recorded yet.</div>
              ) : (
                <table className="min-w-[880px] w-full text-left text-sm">
                  <thead className="bg-[var(--color-bg-alt)] text-[var(--color-text-muted)]">
                    <tr>
                      <th className="px-6 py-3">When</th>
                      <th className="px-4 py-3">Capability</th>
                      <th className="px-4 py-3">Email</th>
                      <th className="px-4 py-3">Model</th>
                      <th className="px-4 py-3 text-right">Tokens</th>
                      <th className="px-4 py-3 text-right">Credits</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedRequestLogs.map((entry, index) => (
                      <tr key={`${entry.timestamp}-${entry.capability}-${index}`} className="border-t border-[var(--color-border)]/60">
                        <td className="whitespace-nowrap px-6 py-3 text-[var(--color-text-muted)]">{formatLocalDateTime(entry.timestamp)}</td>
                        <td className="px-4 py-3 font-mono text-[var(--color-text-main)]">{entry.capability}</td>
                        <td className="px-4 py-3 text-[var(--color-text-muted)]">
                          <div className="flex flex-col gap-1">
                            <span className="whitespace-nowrap font-mono">{entry.apiKeyLabel || "Unknown email"}</span>
                            <span className="font-mono text-xs text-[var(--color-text-muted)]">{entry.entrypoint || "-"}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-[var(--color-text-main)]">{entry.model || entry.requestedModel || "-"}</td>
                        <td className="px-4 py-3 text-right text-[var(--color-text-muted)]">
                          <div className="flex flex-col items-end gap-1">
                            <span>In {fmtNumber(entry.inputTokens)}</span>
                            <span>Out {fmtNumber(entry.outputTokens)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-[var(--color-text-muted)]">{fmtCredits(entry.credits)}</td>
                        <td className="px-4 py-3">
                          <span className={entry.status === "ok" ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}>
                            {formatStatus(entry.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {filteredRequestLogs.length > 0 ? (
              <div className="flex flex-col gap-3 border-t border-[var(--color-border)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-[var(--color-text-muted)]">
                  Page {fmtNumber(currentRequestPage)} of {fmtNumber(totalRequestPages)}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setRequestPage((current) => Math.max(1, current - 1))}
                    disabled={currentRequestPage === 1}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setRequestPage((current) => Math.min(totalRequestPages, current + 1))}
                    disabled={currentRequestPage === totalRequestPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      )}

      <Modal
        isOpen={bulkImportOpen}
        onClose={() => {
          if (bulkImportSaving) return;
          setBulkImportOpen(false);
        }}
        title="Bulk import Morph API keys"
        size="lg"
        footer={(
          <>
            <Button type="button" variant="ghost" onClick={() => setBulkImportOpen(false)} disabled={bulkImportSaving}>
              Cancel
            </Button>
            <Button type="button" variant="primary" onClick={handleSaveBulkImport} loading={bulkImportSaving}>
              Save keys
            </Button>
          </>
        )}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-6 text-[var(--color-text-muted)]">
            Add one key per line using `email|apikey`. If the email already exists, the new key replaces the old one automatically.
          </p>
          <textarea
            value={bulkImportValue}
            onChange={(event) => setBulkImportValue(event.target.value)}
            placeholder={"user@example.com|mk-live-123\nteam@example.com|mk-live-456"}
            className="min-h-[220px] w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-3 text-sm text-[var(--color-text-main)] outline-none transition-colors focus:border-[var(--color-primary)]"
          />
        </div>
      </Modal>
    </div>
  );
}
