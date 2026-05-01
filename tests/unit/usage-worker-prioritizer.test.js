import { describe, expect, it } from "vitest";

import { USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";
import { prioritizeConnections } from "../../src/lib/usageWorker/prioritizer.js";
import { isUsageRefreshableConnection } from "../../src/lib/usageWorker/scheduler.js";

const settings = { intervalMinutes: 15, batchSize: 10 };
const now = new Date("2026-05-01T12:00:00.000Z");

function baseConnection(overrides = {}) {
  return {
    id: overrides.id || "conn-1",
    provider: overrides.provider || "kiro",
    authType: "oauth",
    isActive: true,
    lastCheckedAt: "2026-05-01T11:00:00.000Z",
    usageSnapshot: JSON.stringify({ quotas: {} }),
    ...overrides,
  };
}

describe("usage worker prioritizer", () => {
  it("refreshes credit-based exhausted accounts when resetAt is missing", () => {
    const entries = prioritizeConnections([
      baseConnection({
        id: "kiro-credit",
        provider: "kiro",
        routingStatus: "exhausted",
        quotaState: "exhausted",
        resetAt: null,
      }),
    ], settings, now);

    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe("exhausted_no_reset");
  });

  it("skips time-based exhausted accounts until resetAt passes", () => {
    const entries = prioritizeConnections([
      baseConnection({
        id: "codex-waiting",
        provider: "codex",
        routingStatus: "exhausted",
        quotaState: "exhausted",
        resetAt: "2026-05-01T13:00:00.000Z",
      }),
    ], settings, now);

    expect(entries).toHaveLength(0);
  });

  it("excludes exhausted accounts with future reset from full refresh candidates", () => {
    expect(isUsageRefreshableConnection(baseConnection({
      id: "codex-waiting",
      provider: "codex",
      routingStatus: "exhausted",
      quotaState: "exhausted",
      resetAt: "2026-05-01T13:00:00.000Z",
    }))).toBe(false);
  });

  it("refreshes time-based exhausted accounts after resetAt", () => {
    const entries = prioritizeConnections([
      baseConnection({
        id: "codex-reset",
        provider: "codex",
        routingStatus: "exhausted",
        quotaState: "exhausted",
        resetAt: "2026-05-01T11:30:00.000Z",
      }),
    ], settings, now);

    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe("reset_time_passed");
  });

  it("prioritizes missing usage snapshots before stale accounts", () => {
    const entries = prioritizeConnections([
      baseConnection({ id: "stale" }),
      baseConnection({ id: "missing", usageSnapshot: null }),
    ], settings, now);

    expect(entries.map((entry) => entry.connection.id)).toEqual(["missing", "stale"]);
  });

  it("supports every provider declared as usage-capable", () => {
    const entries = prioritizeConnections(
      USAGE_SUPPORTED_PROVIDERS.map((provider) => baseConnection({
        id: provider,
        provider,
        lastCheckedAt: null,
        usageSnapshot: null,
      })),
      settings,
      now,
    );

    expect(entries.map((entry) => entry.connection.provider).sort()).toEqual([...USAGE_SUPPORTED_PROVIDERS].sort());
  });
});
