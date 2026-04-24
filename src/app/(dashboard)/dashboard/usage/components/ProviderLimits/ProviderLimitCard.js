"use client";

import { useState } from "react";
import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import Badge from "@/shared/components/Badge";
import QuotaProgressBar from "./QuotaProgressBar";
import { calculatePercentage } from "./utils";

const planVariants = {
  free: "default",
  pro: "primary",
  ultra: "success",
  enterprise: "info",
};

export default function ProviderLimitCard({
  provider,
  name,
  plan,
  quotas = [],
  message = null,
  loading = false,
  error = null,
  onRefresh,
}) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;

    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  // Get provider info from config
  const getProviderColor = () => {
    const colors = {
      github: "var(--color-text-main)",
      antigravity: "var(--color-info)",
      codex: "var(--color-success)",
      kiro: "var(--color-warning)",
      claude: "var(--color-primary)",
    };
    return colors[provider?.toLowerCase()] || "var(--color-text-muted)";
  };

  const providerColor = getProviderColor();
  return (
    <Card padding="md" className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Provider Logo */}
          <div
            className="size-10 rounded flex items-center justify-center p-1.5"
            style={{ backgroundColor: `${providerColor}15` }}
          >
            <ProviderIcon
              src={`/providers/${provider}.png`}
              alt={provider || "Provider"}
              size={40}
              className="object-contain rounded"
              fallbackText={provider?.slice(0, 2).toUpperCase() || "PR"}
              fallbackColor={providerColor}
            />
          </div>

          <div>
            <h3 className="font-semibold text-text-main">
              {name || provider}
            </h3>
            {plan && (
              <Badge
                variant={planVariants[plan?.toLowerCase()] || "default"}
                size="xs"
              >
                {plan}
              </Badge>
            )}
          </div>
        </div>

        {/* Refresh Button */}
        <button
          onClick={handleRefresh}
          disabled={refreshing || loading}
          className="p-2 rounded hover:bg-bg-subtle transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Refresh quota"
        >
          <span
            className={`material-symbols-outlined text-[20px] text-text-muted ${
              refreshing || loading ? "animate-spin" : ""
            }`}
          >
            refresh
          </span>
        </button>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="h-4 bg-bg-subtle rounded animate-pulse" />
            <div className="h-2 bg-bg-subtle rounded animate-pulse" />
          </div>
          <div className="space-y-2">
            <div className="h-4 bg-bg-subtle rounded animate-pulse" />
            <div className="h-2 bg-bg-subtle rounded animate-pulse" />
          </div>
        </div>
      )}

      {/* Error State */}
      {!loading && error && (
        <div className="p-4 rounded bg-[var(--color-danger-soft)] border border-[var(--color-danger-border)]">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-[var(--color-danger)] text-[20px]">
              error
            </span>
            <p className="text-sm text-[var(--color-danger)]">{error}</p>
          </div>
        </div>
      )}

      {/* Info Message (for providers without API) */}
      {!loading && !error && message && (
        <div className="p-4 rounded bg-[var(--color-info-soft)] border border-[var(--color-info-border)]">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-[var(--color-info)] text-[20px]">
              info
            </span>
            <p className="text-sm text-[var(--color-info)]">
              {message}
            </p>
          </div>
        </div>
      )}

      {/* Quota Progress Bars */}
      {!loading && !error && !message && quotas?.length > 0 && (
        <div className="space-y-4">
          {quotas.map((quota, index) => {
            // For Antigravity, use remainingPercentage if available, otherwise calculate
            const percentage =
              quota.remainingPercentage !== undefined
                ? Math.round(((quota.total - quota.used) / quota.total) * 100)
                : calculatePercentage(quota.used, quota.total);
            const unlimited = quota.total === 0 || quota.total === null;

            return (
              <QuotaProgressBar
                key={`${quota.name}-${index}`}
                label={quota.name}
                used={quota.used}
                total={quota.total}
                percentage={percentage}
                unlimited={unlimited}
                resetTime={quota.resetAt}
              />
            );
          })}
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && !message && quotas?.length === 0 && (
        <div className="text-center py-8 text-text-muted">
          <span className="material-symbols-outlined text-[48px] opacity-20">
            data_usage
          </span>
          <p className="text-sm mt-2">No quota data available</p>
        </div>
      )}
    </Card>
  );
}
