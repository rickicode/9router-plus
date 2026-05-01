import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getQuotaPresentation,
  getStoredQuotaPresentation,
  parseQuotaData,
  parseStoredUsageSnapshot,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { isTransientUpstreamTimeoutError } from "../../src/lib/usageStatus.js";

describe("parseQuotaData for codex", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns only weekly quota when session is absent", () => {
    const result = parseQuotaData("codex", {
      quotas: {
        weekly: {
          used: 100,
          total: 100,
          remaining: 0,
          resetAt: "2026-04-25T00:00:00.000Z",
        },
      },
    });

    expect(result).toEqual([
      expect.objectContaining({ name: "weekly", used: 100, total: 100 }),
    ]);
  });

  it("parses stored usage snapshots from merged connection state", () => {
    const connection = {
      id: "conn-1",
      provider: "codex",
      usageSnapshot: JSON.stringify({
        plan: "Pro",
        quotas: {
          weekly: {
            used: 25,
            total: 100,
            remaining: 75,
            resetAt: "2026-04-25T00:00:00.000Z",
          },
        },
      }),
    };

    expect(parseStoredUsageSnapshot(connection)).toMatchObject({
      plan: "Pro",
      quotas: {
        weekly: expect.objectContaining({ used: 25, total: 100 }),
      },
    });

    expect(getStoredQuotaPresentation(connection)).toMatchObject({
      plan: "Pro",
      hasSnapshot: true,
      quotas: [
        expect.objectContaining({ name: "weekly", used: 25, total: 100 }),
      ],
    });
  });

  it("returns an empty presentation when snapshot JSON is invalid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const connection = {
      id: "conn-2",
      provider: "codex",
      usageSnapshot: "{bad-json",
    };

    expect(parseStoredUsageSnapshot(connection)).toBeNull();
    expect(getStoredQuotaPresentation(connection)).toEqual({
      quotas: [],
      plan: null,
      message: "Scheduler has not produced quota data for codex yet. This account is still pending its first usage check.",
      raw: null,
      hasSnapshot: false,
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns a non-empty scheduler guidance message even before the first snapshot exists", () => {
    expect(getStoredQuotaPresentation({
      id: "conn-no-check-yet",
      provider: "github",
    })).toEqual({
      quotas: [],
      plan: null,
      message: "Scheduler has not produced quota data for github yet. This account is still pending its first usage check.",
      raw: null,
      hasSnapshot: false,
    });
  });

  it("prefers the real canonical auth failure over a stale usage snapshot message", () => {
    const connection = {
      id: "conn-real-auth",
      provider: "codex",
      authState: "invalid",
      reasonCode: "reauthorization_required",
      reasonDetail: "Token invalid or revoked",
      usageSnapshot: JSON.stringify({
        message: "Codex connected. Usage API temporarily unavailable (401).",
      }),
    };

    expect(getStoredQuotaPresentation(connection)).toEqual({
      quotas: [],
      plan: null,
      message: "Token invalid or revoked",
      raw: {
        message: "Codex connected. Usage API temporarily unavailable (401).",
      },
      hasSnapshot: true,
    });
  });

  it("shows the real auth reason for disabled reauthorization accounts even without a usable quota snapshot", () => {
    const connection = {
      id: "conn-disabled-reauth",
      provider: "codex",
      routingStatus: "disabled",
      authState: "invalid",
      reasonCode: "reauthorization_required",
      reasonDetail: "Token invalid or revoked",
    };

    expect(getStoredQuotaPresentation(connection)).toEqual({
      quotas: [],
      plan: null,
      message: "Token invalid or revoked",
      raw: null,
      hasSnapshot: false,
    });
  });

  it("shows a real fallback result once the scheduler has checked an account but no quota snapshot was returned", () => {
    const connection = {
      id: "conn-checked-no-snapshot",
      provider: "claude",
      routingStatus: "unknown",
      lastCheckedAt: "2026-04-30T10:00:00.000Z",
    };

    expect(getStoredQuotaPresentation(connection)).toEqual({
      quotas: [],
      plan: null,
      message: "Usage for claude was checked, but the provider did not return a detailed quota snapshot.",
      raw: null,
      hasSnapshot: false,
    });
  });

  it("no longer tells Codex users to manually refresh after scheduler data exists", () => {
    const presentation = getStoredQuotaPresentation({
      id: "conn-checked-no-snapshot",
      provider: "codex",
      routingStatus: "eligible",
      lastCheckedAt: "2026-04-30T10:00:00.000Z",
      reasonDetail: "Codex connected. Usage API temporarily unavailable (401).",
    });

    expect(presentation.message).not.toContain("Refresh usage to check this account.");
    expect(presentation.message).toBe("Codex connected. Usage API temporarily unavailable (401).");
  });

  it("prefers the latest failed test-connection result over stored usage snapshot text", () => {
    const connection = {
      id: "conn-live-test-fail",
      provider: "codex",
      routingStatus: "eligible",
      healthStatus: "degraded",
      quotaState: "ok",
      authState: "ok",
      usageSnapshot: JSON.stringify({
        message: "Codex connected. Usage API temporarily unavailable (401).",
      }),
    };

    expect(getQuotaPresentation(connection, {
      valid: false,
      error: "Token invalid or revoked",
    })).toEqual({
      quotas: [],
      plan: null,
      message: "Token invalid or revoked",
      raw: {
        message: "Codex connected. Usage API temporarily unavailable (401).",
      },
      hasSnapshot: true,
    });
  });

  it("falls back to stored quota presentation when the latest test result is healthy", () => {
    const connection = {
      id: "conn-live-test-ok",
      provider: "codex",
      routingStatus: "eligible",
      healthStatus: "degraded",
      quotaState: "ok",
      authState: "ok",
      usageSnapshot: JSON.stringify({
        message: "Codex connected. Usage API temporarily unavailable (401).",
      }),
    };

    expect(getQuotaPresentation(connection, {
      valid: true,
      error: null,
    })).toEqual({
      quotas: [],
      plan: null,
      message: "Codex connected. Usage API temporarily unavailable (401).",
      raw: {
        message: "Codex connected. Usage API temporarily unavailable (401).",
      },
      hasSnapshot: true,
    });
  });

  it("keeps stored quota bars visible when the latest test result is a provider quota error", () => {
    const connection = {
      id: "conn-quota-with-test-error",
      provider: "codex",
      routingStatus: "exhausted",
      quotaState: "exhausted",
      authState: "ok",
      usageSnapshot: JSON.stringify({
        quotas: {
          session: {
            used: 52,
            total: 100,
            remaining: 48,
            resetAt: "2026-05-07T17:29:00.000Z",
          },
        },
      }),
    };

    expect(getQuotaPresentation(connection, {
      valid: false,
      error: "[429]: {\"error\":{\"type\":\"usage_limit_reached\",\"message\":\"The usage limit has been reached\"}}",
    })).toMatchObject({
      message: null,
      quotas: [
        expect.objectContaining({ name: "session", used: 52, total: 100 }),
      ],
    });
  });

  it("keeps the usage snapshot message when the canonical connection status is still healthy", () => {
    const connection = {
      id: "conn-usage-only",
      provider: "codex",
      routingStatus: "eligible",
      healthStatus: "degraded",
      quotaState: "ok",
      authState: "ok",
      reasonCode: "usage_request_failed",
      reasonDetail: "Codex connected. Usage API temporarily unavailable (401).",
      usageSnapshot: JSON.stringify({
        message: "Codex connected. Usage API temporarily unavailable (401).",
      }),
    };

    expect(getStoredQuotaPresentation(connection)).toEqual({
      quotas: [],
      plan: null,
      message: "Codex connected. Usage API temporarily unavailable (401).",
      raw: {
        message: "Codex connected. Usage API temporarily unavailable (401).",
      },
      hasSnapshot: true,
    });
  });

  it("prefers the real exhausted reason over stored quota snapshot text", () => {
    const connection = {
      id: "conn-real-exhausted",
      provider: "codex",
      quotaState: "exhausted",
      reasonCode: "quota_exhausted",
      reasonDetail: "Codex weekly quota exhausted",
      usageSnapshot: JSON.stringify({
        quotas: {
          weekly: {
            used: 100,
            total: 100,
            remaining: 0,
            resetAt: "2026-04-25T00:00:00.000Z",
          },
        },
        message: "Old usage message",
      }),
    };

    expect(getStoredQuotaPresentation(connection)).toMatchObject({
      plan: null,
      message: "Old usage message",
      hasSnapshot: true,
      quotas: [
        expect.objectContaining({ name: "weekly", used: 100, total: 100 }),
      ],
    });
  });

  it("keeps quota tables visible and hides raw provider JSON for threshold-based exhausted accounts", () => {
    const connection = {
      id: "conn-threshold-exhausted",
      provider: "codex",
      quotaState: "exhausted",
      reasonCode: "quota_threshold",
      reasonDetail: "Remaining quota is at or below 10%",
      usageSnapshot: JSON.stringify({
        quotas: {
          weekly: {
            used: 91,
            total: 100,
            remaining: 9,
            resetAt: "2026-04-25T00:00:00.000Z",
          },
        },
        message: "[429]: {\"error\":{\"type\":\"usage_limit_reached\",\"message\":\"The usage limit has been reached\"}}",
      }),
    };

    expect(getStoredQuotaPresentation(connection)).toMatchObject({
      hasSnapshot: true,
      message: null,
      quotas: [
        expect.objectContaining({ name: "weekly", used: 91, total: 100 }),
      ],
    });
  });

  it("still shows parsed quotas for exhausted connections without a real reason detail", () => {
    const connection = {
      id: "conn-exhausted-quotas",
      provider: "codex",
      quotaState: "exhausted",
      usageSnapshot: JSON.stringify({
        quotas: {
          weekly: {
            used: 100,
            total: 100,
            remaining: 0,
            resetAt: "2026-04-25T00:00:00.000Z",
          },
        },
      }),
    };

    expect(getStoredQuotaPresentation(connection)).toMatchObject({
      message: null,
      hasSnapshot: true,
      quotas: [
        expect.objectContaining({ name: "weekly", used: 100, total: 100 }),
      ],
    });
  });

  it("preserves only valid Kiro remaining percentages and avoids inventing invalid ones", () => {
    const validResult = parseQuotaData("kiro", {
      quotas: {
        agentic_request: {
          used: 80,
          total: 100,
          resetAt: "2026-04-25T00:00:00.000Z",
          remainingPercentage: 20,
        },
      },
    });

    expect(validResult).toEqual([
      expect.objectContaining({
        name: "agentic_request",
        used: 80,
        total: 100,
        remainingPercentage: 20,
      }),
    ]);

    const invalidResult = parseQuotaData("kiro", {
      quotas: {
        agentic_request: {
          used: 80,
          total: 0,
          resetAt: "2026-04-25T00:00:00.000Z",
          remainingPercentage: NaN,
        },
      },
    });

    expect(invalidResult).toEqual([
      expect.objectContaining({
        name: "agentic_request",
        used: 80,
        total: 0,
      }),
    ]);
    expect(invalidResult[0]).not.toHaveProperty("remainingPercentage");
  });
});

describe("transient upstream timeout detection", () => {
  it("treats upstream timeout errors as transient", () => {
    expect(isTransientUpstreamTimeoutError({
      message: "codex upstream timed out after 45000ms",
      code: "UPSTREAM_TIMEOUT",
    })).toBe(true);
  });

  it("treats stream idle timeouts as transient", () => {
    expect(isTransientUpstreamTimeoutError({
      message: "codex stream idle timed out after 120000ms",
      code: "STREAM_IDLE_TIMEOUT",
    })).toBe(true);
  });

  it("does not treat auth failures as transient timeouts", () => {
    expect(isTransientUpstreamTimeoutError({
      message: "Token invalid or revoked",
      code: "AUTH_INVALID",
    }, {
      statusCode: 401,
    })).toBe(false);
  });
});
