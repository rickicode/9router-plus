import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConnections = [];
const updateProviderConnection = vi.fn(async (id, data) => ({ id, ...data }));
const getProviderConnectionById = vi.fn(async (id) => mockConnections.find((conn) => conn.id === id) || null);
const getProviderConnections = vi.fn(async ({ provider } = {}) => {
  if (!provider) return [...mockConnections];
  return mockConnections.filter((conn) => conn.provider === provider);
});
const getSettings = vi.fn(async () => ({ quotaExhaustedThresholdPercent: 10 }));
const getUsageForProvider = vi.fn(async () => ({ ok: true }));
const testSingleConnection = vi.fn(async () => ({ valid: true }));
const writeConnectionHotState = vi.fn(async ({ patch }) => patch);
const needsRefresh = vi.fn(() => false);
const refreshCredentials = vi.fn(async () => null);
const runUsageRefreshJob = vi.fn(async (_connectionId, handler) => handler());
const runDedupedUsageRefreshJob = vi.fn(async (_connectionId, handler) => handler());
let writeConnectionHotStateImpl = async ({ patch }) => patch;
let providerHotStateActualModule = null;

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById,
  getProviderConnections,
  getSettings,
  updateProviderConnection,
}));

vi.mock("@/lib/providerHotState", async () => {
  const actual = await vi.importActual("../../src/lib/providerHotState.js");
  providerHotStateActualModule = actual;
  return {
    ...actual,
    writeConnectionHotState: vi.fn(async (args) => {
      const result = await writeConnectionHotStateImpl(args);
      writeConnectionHotState(args);
      return result;
    }),
  };
});

vi.mock("@/app/api/providers/[id]/test/testUtils.js", () => ({
  testSingleConnection,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider,
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    needsRefresh,
    refreshCredentials,
  }),
}));

vi.mock("../../src/lib/usageRefreshQueue.js", () => ({
  runUsageRefreshJob,
  runDedupedUsageRefreshJob,
}));

vi.mock("@/lib/connectionStatus", async () => await import("../../src/lib/connectionStatus.js"));

describe("usage request status sync", () => {
  beforeEach(() => {
    mockConnections.length = 0;
    updateProviderConnection.mockClear();
    getProviderConnectionById.mockClear();
    getProviderConnections.mockClear();
    getSettings.mockClear();
    getSettings.mockResolvedValue({ quotaExhaustedThresholdPercent: 10 });
    getUsageForProvider.mockClear();
    testSingleConnection.mockClear();
    testSingleConnection.mockResolvedValue({ valid: true });
    writeConnectionHotState.mockClear();
    needsRefresh.mockClear();
    refreshCredentials.mockClear();
    needsRefresh.mockImplementation(() => false);
    refreshCredentials.mockImplementation(async () => null);
    runUsageRefreshJob.mockClear();
    runUsageRefreshJob.mockImplementation(async (_connectionId, handler) => handler());
    runDedupedUsageRefreshJob.mockClear();
    runDedupedUsageRefreshJob.mockImplementation(async (_connectionId, handler) => handler());
    writeConnectionHotStateImpl = async ({ patch }) => patch;
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const sqliteHelpers = await import("../../src/lib/sqliteHelpers.js");
      sqliteHelpers.closeSqliteDb?.();
    } catch {}
  });

  it("does not persist status recovery when token refresh succeeds but background refresh skips transient connectivity errors", async () => {
    mockConnections.push({
      id: "conn-refresh-skip",
      provider: "codex",
      authType: "oauth",
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      usageSnapshot: JSON.stringify({ provider: "codex", message: "previous snapshot" }),
      routingStatus: "blocked",
      authState: "ok",
    });

    needsRefresh.mockImplementation(() => true);
    refreshCredentials.mockResolvedValueOnce({
      accessToken: "fresh-token",
      refreshToken: "fresh-refresh-token",
      expiresIn: 3600,
    });
    getUsageForProvider.mockRejectedValueOnce(new Error("fetch failed"));

    const { refreshConnectionUsage } = await import("../../src/lib/connectionUsageRefresh.js");
    const result = await refreshConnectionUsage("conn-refresh-skip", {
      skipTransientConnectivityErrors: true,
    });

    expect(result).toMatchObject({ skipped: true, skipReason: "transient_connectivity_error" });
    expect(updateProviderConnection).toHaveBeenCalledWith("conn-refresh-skip", expect.objectContaining({
      accessToken: "fresh-token",
      refreshToken: "fresh-refresh-token",
      expiresAt: expect.any(String),
    }));
    expect(writeConnectionHotState).not.toHaveBeenCalled();
  });

  it("marks the connection active after successful usage fetch", async () => {
    mockConnections.push({
      id: "conn-1",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      testStatus: "unknown",
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-1"), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });

    expect(response.status).toBe(200);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-1",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "eligible",
        quotaState: "ok",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("marks weekly-only Codex connections unavailable when weekly quota is exhausted", async () => {
    mockConnections.push({
      id: "conn-weekly-exhausted",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      testStatus: "unknown",
    });

    getUsageForProvider.mockResolvedValueOnce({
      plan: "free",
      quotas: {
        weekly: {
          used: 100,
          total: 100,
          remaining: 0,
          resetAt: "2026-04-25T00:00:00.000Z",
        },
      },
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-weekly-exhausted"), {
      params: Promise.resolve({ connectionId: "conn-weekly-exhausted" }),
    });

    expect(response.status).toBe(200);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-weekly-exhausted",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "exhausted",
        quotaState: "exhausted",
        nextRetryAt: "2026-04-25T00:00:00.000Z",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("marks Codex connections unavailable when session quota is exhausted even if weekly quota remains", async () => {
    mockConnections.push({
      id: "conn-session-exhausted",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      testStatus: "unknown",
    });

    getUsageForProvider.mockResolvedValueOnce({
      plan: "pro",
      quotas: {
        session: {
          used: 100,
          total: 100,
          remaining: 0,
          resetAt: "2026-04-25T00:00:00.000Z",
        },
        weekly: {
          used: 10,
          total: 100,
          remaining: 90,
          resetAt: "2026-04-27T00:00:00.000Z",
        },
      },
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-session-exhausted"), {
      params: Promise.resolve({ connectionId: "conn-session-exhausted" }),
    });

    expect(response.status).toBe(200);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-session-exhausted",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "exhausted",
        quotaState: "exhausted",
        nextRetryAt: "2026-04-25T00:00:00.000Z",
        reasonDetail: "Codex session quota exhausted",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps weekly-only Codex connections active when weekly quota remains", async () => {
    mockConnections.push({
      id: "conn-weekly-active",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      testStatus: "unknown",
    });

    getUsageForProvider.mockResolvedValueOnce({
      plan: "free",
      quotas: {
        weekly: {
          used: 55,
          total: 100,
          remaining: 45,
          resetAt: "2026-04-25T00:00:00.000Z",
        },
      },
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-weekly-active"), {
      params: Promise.resolve({ connectionId: "conn-weekly-active" }),
    });

    expect(response.status).toBe(200);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-weekly-active",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "eligible",
        quotaState: "ok",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("exports canonical usage refresh logic that scheduler code can reuse", async () => {
    const { applyCanonicalUsageRefresh } = await import("../../src/lib/usageStatus.js");

    await applyCanonicalUsageRefresh({ id: "conn-reuse", provider: "codex" }, {
      plan: "free",
      limitReached: true,
      quotas: {
        weekly: {
          used: 100,
          total: 100,
          remaining: 0,
          resetAt: "2026-04-25T00:00:00.000Z",
        },
      },
    });

    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-reuse",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "exhausted",
        quotaState: "exhausted",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("strips legacy mirror fields before writing migrated syncUsageStatus patches", async () => {
    const { syncUsageStatus } = await import("../../src/lib/usageStatus.js");

    await syncUsageStatus(
      { id: "conn-sync-legacy-strip", provider: "codex" },
      {
        routingStatus: "blocked",
        authState: "invalid",
        reasonCode: "auth_invalid",
        reasonDetail: "Token expired",
        lastCheckedAt: "2026-04-23T01:02:03.000Z",
        testStatus: "expired",
        lastTested: "2026-04-23T01:02:03.000Z",
        lastErrorType: "auth_invalid",
        lastErrorAt: "2026-04-23T01:02:03.000Z",
        rateLimitedUntil: "2026-04-23T01:02:03.000Z",
        errorCode: "auth_invalid",
        lastError: "Token expired",
      }
    );

    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-sync-legacy-strip",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "blocked",
        authState: "invalid",
        reasonCode: "auth_invalid",
        reasonDetail: "Token expired",
        lastCheckedAt: "2026-04-23T01:02:03.000Z",
      }),
    }));

    const [{ patch }] = writeConnectionHotState.mock.calls.at(-1);
    expect(patch).not.toHaveProperty("testStatus");
    expect(patch).not.toHaveProperty("lastTested");
    expect(patch).not.toHaveProperty("lastErrorType");
    expect(patch).not.toHaveProperty("lastErrorAt");
    expect(patch).not.toHaveProperty("rateLimitedUntil");
    expect(patch).not.toHaveProperty("errorCode");
    expect(patch).not.toHaveProperty("lastError");

    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("never mirrors canonical status back into legacy fields", async () => {
    writeConnectionHotState.mockResolvedValueOnce({
      routingStatus: "blocked",
      authState: "invalid",
      testStatus: "expired",
      rateLimitedUntil: "2099-01-01T00:00:00.000Z",
    });

    const { syncUsageStatus } = await import("../../src/lib/usageStatus.js");

    const result = await syncUsageStatus({ id: "conn-1", provider: "codex" }, {
      routingStatus: "blocked",
      authState: "invalid",
      testStatus: "expired",
      rateLimitedUntil: "2099-01-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      routingStatus: "blocked",
      authState: "invalid",
    });
    expect(result).not.toHaveProperty("testStatus");
    expect(result).not.toHaveProperty("rateLimitedUntil");
  });

  it("persists canonical hot-state to SQLite when syncUsageStatus writes without Redis", async () => {
    const providerHotState = await import("../../src/lib/providerHotState.js");
    const sqliteHelpers = await import("../../src/lib/sqliteHelpers.js");
    providerHotState.__resetProviderHotStateForTests();
    sqliteHelpers.clearAllSqliteHotState();

    writeConnectionHotStateImpl = providerHotStateActualModule.writeConnectionHotState;

    const { syncUsageStatus } = await import("../../src/lib/usageStatus.js");

    await syncUsageStatus(
      { id: "conn-sqlite-fallback", provider: "codex" },
      {
        routingStatus: "blocked",
        quotaState: "exhausted",
        authState: "invalid",
        reasonCode: "quota_exhausted",
        reasonDetail: "Weekly quota exhausted",
        nextRetryAt: "2026-04-26T00:00:00.000Z",
        lastCheckedAt: "2026-04-25T12:00:00.000Z",
        apiKey: "secret-api-key",
        accessToken: "secret-access-token",
        refreshToken: "secret-refresh-token",
        baseUrl: "https://example.com",
      }
    );

    providerHotState.__resetProviderHotStateForTests();

    const durableSnapshot = await providerHotState.getConnectionHotState("conn-sqlite-fallback", "codex");
    expect(durableSnapshot).toEqual({
      id: "conn-sqlite-fallback",
      routingStatus: "blocked",
      quotaState: "exhausted",
      authState: "invalid",
      reasonCode: "quota_exhausted",
      reasonDetail: "Weekly quota exhausted",
      nextRetryAt: "2026-04-26T00:00:00.000Z",
      lastCheckedAt: "2026-04-25T12:00:00.000Z",
      usageSnapshot: expect.any(String),
      version: expect.any(Number),
    });
    expect(durableSnapshot).not.toHaveProperty("apiKey");
    expect(durableSnapshot).not.toHaveProperty("accessToken");
    expect(durableSnapshot).not.toHaveProperty("refreshToken");
    expect(durableSnapshot).not.toHaveProperty("baseUrl");

    expect(sqliteHelpers.loadHotStates("codex", ["conn-sqlite-fallback"])).toEqual({
      "conn-sqlite-fallback": {
        routingStatus: "blocked",
        quotaState: "exhausted",
        authState: "invalid",
        reasonCode: "quota_exhausted",
        reasonDetail: "Weekly quota exhausted",
        nextRetryAt: "2026-04-26T00:00:00.000Z",
        lastCheckedAt: "2026-04-25T12:00:00.000Z",
        usageSnapshot: expect.any(String),
        version: expect.any(Number),
      },
    });
  });

  it("records Codex usage API 401 responses as degraded usage-check failures instead of auth failures", async () => {
    const { applyCanonicalUsageRefresh } = await import("../../src/lib/usageStatus.js");

    await applyCanonicalUsageRefresh({ id: "conn-codex-401", provider: "codex" }, {
      message: "Codex connected. Usage API temporarily unavailable (401).",
    });

    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-codex-401",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "eligible",
        healthStatus: "degraded",
        authState: "ok",
        reasonCode: "usage_request_failed",
        reasonDetail: "Codex connected. Usage API temporarily unavailable (401).",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not let generic eligible usage patches revive auth-invalid connections", async () => {
    const { syncUsageStatus } = await import("../../src/lib/usageStatus.js");

    const snapshot = await syncUsageStatus({
      id: "conn-auth-invalid",
      provider: "codex",
      routingStatus: "blocked",
      authState: "invalid",
      reasonCode: "auth_invalid",
      reasonDetail: "Token expired",
    }, {
      routingStatus: "eligible",
      authState: "ok",
      healthStatus: "healthy",
      quotaState: "ok",
      reasonCode: "unknown",
      reasonDetail: null,
    });

    expect(writeConnectionHotState).not.toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-auth-invalid",
    }));
    expect(snapshot).toMatchObject({
      routingStatus: "blocked",
      authState: "invalid",
      reasonCode: "auth_invalid",
      reasonDetail: "Token expired",
    });
  });

  it("marks codex as exhausted when remaining falls below the default global threshold", async () => {
    const { applyCanonicalUsageRefresh } = await import("../../src/lib/usageStatus.js");

    await applyCanonicalUsageRefresh({ id: "conn-threshold-default", provider: "codex" }, {
      plan: "pro",
      quotas: {
        weekly: {
          used: 91,
          total: 100,
          remaining: 9,
          resetAt: "2026-04-25T00:00:00.000Z",
        },
      },
    });

    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-threshold-default",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "exhausted",
        quotaState: "exhausted",
        reasonCode: "quota_threshold",
        nextRetryAt: "2026-04-25T00:00:00.000Z",
      }),
    }));
  });

  it("marks codex as exhausted when remainingPercentage is a numeric string at the configured threshold", async () => {
    const { applyCanonicalUsageRefresh } = await import("../../src/lib/usageStatus.js");

    await applyCanonicalUsageRefresh(
      { id: "conn-threshold-string", provider: "codex" },
      {
        plan: "pro",
        quotas: {
          weekly: {
            used: "99",
            total: "100",
            remaining: "1",
            remainingPercentage: "1",
            resetAt: "2026-04-25T00:00:00.000Z",
          },
        },
      },
      { globalExhaustedThreshold: 10 }
    );

    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-threshold-string",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "exhausted",
        quotaState: "exhausted",
        reasonCode: "quota_threshold",
        nextRetryAt: "2026-04-25T00:00:00.000Z",
      }),
    }));
  });

  it("uses settings threshold for manual usage refreshes without scheduler options", async () => {
    mockConnections.push({
      id: "conn-manual-threshold",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      testStatus: "unknown",
    });
    getSettings.mockResolvedValueOnce({ quotaExhaustedThresholdPercent: 10 });
    getUsageForProvider.mockResolvedValueOnce({
      plan: "pro",
      quotas: {
        weekly: {
          used: 99,
          total: 100,
          remaining: 1,
          remainingPercentage: 1,
          resetAt: "2026-04-25T00:00:00.000Z",
        },
      },
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-manual-threshold?test=1"), {
      params: Promise.resolve({ connectionId: "conn-manual-threshold" }),
    });

    expect(response.status).toBe(200);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-manual-threshold",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "exhausted",
        quotaState: "exhausted",
        reasonCode: "quota_threshold",
      }),
    }));
  });

  it("blocks Kiro connections when a valid remaining percent falls at or below the configured threshold", async () => {
    const { applyCanonicalUsageRefresh } = await import("../../src/lib/usageStatus.js");

    await applyCanonicalUsageRefresh(
      {
        id: "conn-kiro-threshold",
        provider: "kiro",
        providerSpecificData: { minimumRemainingQuotaPercent: 25 },
      },
      {
        plan: "Kiro",
        quotas: {
          agentic_request: {
            used: 80,
            total: 100,
            resetAt: "2026-04-25T00:00:00.000Z",
          },
        },
      }
    );

    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-kiro-threshold",
      provider: "kiro",
      patch: expect.objectContaining({
        routingStatus: "exhausted",
        quotaState: "exhausted",
        reasonCode: "quota_threshold",
        nextRetryAt: "2026-04-25T00:00:00.000Z",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not block Kiro threshold routing when remaining percent cannot be determined safely", async () => {
    const { applyCanonicalUsageRefresh } = await import("../../src/lib/usageStatus.js");

    await applyCanonicalUsageRefresh(
      {
        id: "conn-kiro-unknown-total",
        provider: "kiro",
        providerSpecificData: { minimumRemainingQuotaPercent: 25 },
      },
      {
        plan: "Kiro",
        quotas: {
          agentic_request: {
            used: 80,
            total: 0,
            resetAt: "2026-04-25T00:00:00.000Z",
          },
        },
      }
    );

    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-kiro-unknown-total",
      provider: "kiro",
      patch: expect.objectContaining({
        routingStatus: "eligible",
        quotaState: "ok",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("uses remaining and total to derive Kiro threshold exhaustion when used is absent", async () => {
    const { applyCanonicalUsageRefresh } = await import("../../src/lib/usageStatus.js");

    await applyCanonicalUsageRefresh(
      {
        id: "conn-kiro-remaining-total",
        provider: "kiro",
        providerSpecificData: { minimumRemainingQuotaPercent: 25 },
      },
      {
        plan: "Kiro",
        quotas: {
          agentic_request: {
            remaining: 20,
            total: 100,
            resetAt: "2026-04-25T00:00:00.000Z",
          },
        },
      }
    );

    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-kiro-remaining-total",
      provider: "kiro",
      patch: expect.objectContaining({
        routingStatus: "exhausted",
        quotaState: "exhausted",
        reasonCode: "quota_threshold",
        nextRetryAt: "2026-04-25T00:00:00.000Z",
      }),
    }));
  });

  it("still blocks Kiro connections on explicit non-threshold exhaustion signals", async () => {
    const { applyCanonicalUsageRefresh } = await import("../../src/lib/usageStatus.js");

    await applyCanonicalUsageRefresh(
      {
        id: "conn-kiro-exhausted",
        provider: "kiro",
        providerSpecificData: { minimumRemainingQuotaPercent: 25 },
      },
      {
        plan: "Kiro",
        limitReached: true,
        quotas: {
          agentic_request: {
            used: 5,
            total: 0,
            resetAt: "2026-04-25T00:00:00.000Z",
          },
        },
      }
    );

    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-kiro-exhausted",
      provider: "kiro",
      patch: expect.objectContaining({
        routingStatus: "exhausted",
        quotaState: "exhausted",
        reasonCode: "quota_exhausted",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("applies immediate live Codex quota exhaustion updates without polling usage again", async () => {
    const { applyLiveQuotaUpdate, getCodexLiveQuotaSignal } = await import("../../src/lib/usageStatus.js");

    const signal = getCodexLiveQuotaSignal(
      { id: "conn-live", provider: "codex" },
      { statusCode: 429, errorText: "You have exceeded your current quota. Limit reached." }
    );

    expect(signal).toEqual(expect.objectContaining({
      kind: "quota_exhausted",
      reasonCode: "quota_exhausted",
    }));

    await applyLiveQuotaUpdate({ id: "conn-live", provider: "codex" }, signal);

    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-live",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "exhausted",
        quotaState: "exhausted",
        reasonCode: "quota_exhausted",
        reasonDetail: "Codex quota exhausted",
        usageSnapshot: expect.any(String),
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
    expect(getUsageForProvider).not.toHaveBeenCalled();
  });

  it("recognizes Codex usage_limit_reached payloads as quota exhaustion", async () => {
    const { getCodexLiveQuotaSignal } = await import("../../src/lib/usageStatus.js");

    const signal = getCodexLiveQuotaSignal(
      { id: "conn-live-json", provider: "codex" },
      {
        statusCode: 429,
        errorText: JSON.stringify({
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
            resets_at: 1777777777,
          },
        }),
      }
    );

    expect(signal).toMatchObject({
      kind: "quota_exhausted",
      reasonCode: "quota_exhausted",
      reasonDetail: "Codex quota exhausted",
      resetAt: new Date(1777777777 * 1000).toISOString(),
    });
  });

  it("does not treat generic Codex 429 throttling as quota exhaustion", async () => {
    const { getCodexLiveQuotaSignal } = await import("../../src/lib/usageStatus.js");

    const signal = getCodexLiveQuotaSignal(
      { id: "conn-throttle", provider: "codex" },
      { statusCode: 429, errorText: "Rate limit exceeded. Too many requests, please retry later." }
    );

    expect(signal).toBeNull();
  });

  it("preserves queue overload status codes from the usage refresh queue", async () => {
    mockConnections.push({
      id: "conn-overloaded",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      testStatus: "unknown",
    });

    runDedupedUsageRefreshJob.mockRejectedValueOnce(Object.assign(
      new Error("Usage refresh queue is overloaded. Please retry shortly."),
      { status: 503 },
    ));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-overloaded"), {
      params: Promise.resolve({ connectionId: "conn-overloaded" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Usage refresh queue is overloaded. Please retry shortly.",
    });
    expect(getUsageForProvider).not.toHaveBeenCalled();
  });


  it("merges providerSpecificData from forced refresh before retrying usage", async () => {
    const connection = {
      id: "conn-refresh-psd",
      provider: "github",
      authType: "oauth",
      accessToken: "old-token",
      refreshToken: "refresh-token",
      providerSpecificData: { existingFlag: true },
    };

    mockConnections.push(connection);
    refreshCredentials.mockResolvedValueOnce({
      accessToken: "new-token",
      refreshToken: "new-refresh",
      expiresIn: 3600,
      providerSpecificData: { copilotToken: "new-copilot", copilotTokenExpiresAt: 123456 },
    });
    getUsageForProvider.mockResolvedValueOnce({ message: "ok" });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-refresh-psd"), {
      params: Promise.resolve({ connectionId: "conn-refresh-psd" }),
    });

    expect(response.status).toBe(200);
    expect(updateProviderConnection).toHaveBeenCalledWith("conn-refresh-psd", expect.objectContaining({
      accessToken: "new-token",
      refreshToken: "new-refresh",
      providerSpecificData: {
        existingFlag: true,
        copilotToken: "new-copilot",
        copilotTokenExpiresAt: 123456,
      },
    }));
    expect(getUsageForProvider).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "new-token",
      refreshToken: "new-refresh",
      providerSpecificData: {
        existingFlag: true,
        copilotToken: "new-copilot",
        copilotTokenExpiresAt: 123456,
      },
    }));
  });

  it("writes canonical blocked-auth state when credential refresh confirms re-authorization is required", async () => {
    mockConnections.push({
      id: "conn-refresh-auth-fail",
      provider: "codex",
      authType: "oauth",
      accessToken: "stale-token",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      routingStatus: "eligible",
      authState: "ok",
      testStatus: "active",
    });

    needsRefresh.mockReturnValueOnce(true);
    refreshCredentials.mockRejectedValueOnce(new Error("Token expired and refresh failed"));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-refresh-auth-fail"), {
      params: Promise.resolve({ connectionId: "conn-refresh-auth-fail" }),
    });

    expect(response.status).toBe(401);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-refresh-auth-fail",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "blocked",
        authState: "invalid",
        reasonCode: "auth_invalid",
        reasonDetail: "Token expired and refresh failed",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("writes canonical blocked-auth state when auth-expired usage retry cannot refresh", async () => {
    mockConnections.push({
      id: "conn-usage-auth-fail",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      routingStatus: "eligible",
      authState: "ok",
      testStatus: "active",
    });

    getUsageForProvider.mockResolvedValueOnce({
      message: "Authentication expired. Please sign in again.",
    });
    refreshCredentials.mockRejectedValueOnce(new Error("Token expired and refresh failed"));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-usage-auth-fail"), {
      params: Promise.resolve({ connectionId: "conn-usage-auth-fail" }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Credential refresh failed: Token expired and refresh failed",
    });
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-usage-auth-fail",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "blocked",
        authState: "invalid",
        reasonCode: "auth_invalid",
        reasonDetail: "Token expired and refresh failed",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("writes canonical blocked-auth state when refresh requires re-authorization", async () => {
    mockConnections.push({
      id: "conn-reauthorize-required",
      provider: "codex",
      authType: "oauth",
      accessToken: null,
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      routingStatus: "eligible",
      authState: "ok",
      testStatus: "active",
    });

    needsRefresh.mockReturnValueOnce(true);
    refreshCredentials.mockResolvedValueOnce(null);

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-reauthorize-required"), {
      params: Promise.resolve({ connectionId: "conn-reauthorize-required" }),
    });

    expect(response.status).toBe(401);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-reauthorize-required",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "disabled",
        authState: "invalid",
        reasonCode: "reauthorization_required",
        reasonDetail: "Failed to refresh credentials. Please re-authorize the connection.",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("writes canonical blocked-auth state when usage fetch throws unauthorized error", async () => {
    mockConnections.push({
      id: "conn-usage-throws-unauthorized",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      routingStatus: "eligible",
      authState: "ok",
      testStatus: "active",
    });

    getUsageForProvider.mockRejectedValueOnce(Object.assign(
      new Error("401 Unauthorized: token revoked"),
      { status: 401 },
    ));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-usage-throws-unauthorized"), {
      params: Promise.resolve({ connectionId: "conn-usage-throws-unauthorized" }),
    });

    expect(response.status).toBe(401);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-usage-throws-unauthorized",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "disabled",
        authState: "invalid",
        reasonCode: "reauthorization_required",
        reasonDetail: "401 Unauthorized: token revoked",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("writes canonical blocked-auth state when usage fetch throws generic 401 error", async () => {
    mockConnections.push({
      id: "conn-usage-throws-generic-401",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      routingStatus: "eligible",
      authState: "ok",
      testStatus: "active",
    });

    getUsageForProvider.mockRejectedValueOnce(Object.assign(
      new Error("Request failed"),
      { status: 401 },
    ));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-usage-throws-generic-401"), {
      params: Promise.resolve({ connectionId: "conn-usage-throws-generic-401" }),
    });

    expect(response.status).toBe(401);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-usage-throws-generic-401",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "blocked",
        authState: "invalid",
        reasonCode: "auth_invalid",
        reasonDetail: "Request failed",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not classify generic 403 usage errors as auth-blocked", async () => {
    mockConnections.push({
      id: "conn-usage-throws-generic-403",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      routingStatus: "eligible",
      authState: "ok",
      testStatus: "active",
    });

    getUsageForProvider.mockRejectedValueOnce(Object.assign(
      new Error("Request failed"),
      { status: 403 },
    ));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-usage-throws-generic-403"), {
      params: Promise.resolve({ connectionId: "conn-usage-throws-generic-403" }),
    });

    expect(response.status).toBe(403);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-usage-throws-generic-403",
      provider: "codex",
      patch: expect.objectContaining({
        reasonCode: "usage_request_failed",
        reasonDetail: "Request failed",
      }),
    }));
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-usage-throws-generic-403",
      patch: expect.not.objectContaining({
        testStatus: expect.anything(),
        lastErrorType: expect.anything(),
        lastTested: expect.anything(),
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("retries transient upstream timeouts 3 times and skips without persisting account status", async () => {
    mockConnections.push({
      id: "conn-usage-timeout",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      routingStatus: "eligible",
      authState: "ok",
      reasonCode: "unknown",
      reasonDetail: null,
      testStatus: "active",
    });

    getUsageForProvider
      .mockRejectedValueOnce(Object.assign(
        new Error("codex upstream timed out after 45000ms"),
        { status: 504, code: "UPSTREAM_TIMEOUT" },
      ))
      .mockRejectedValueOnce(Object.assign(
        new Error("codex upstream timed out after 45000ms"),
        { status: 504, code: "UPSTREAM_TIMEOUT" },
      ))
      .mockRejectedValueOnce(Object.assign(
        new Error("codex upstream timed out after 45000ms"),
        { status: 504, code: "UPSTREAM_TIMEOUT" },
      ));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-usage-timeout?test=1"), {
      params: Promise.resolve({ connectionId: "conn-usage-timeout" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      skipped: true,
      skipReason: "transient_connectivity_error",
    });
    expect(getUsageForProvider).toHaveBeenCalledTimes(3);
    expect(writeConnectionHotState).not.toHaveBeenCalled();
  });

  it("recovers successfully when a transient usage timeout succeeds on retry", async () => {
    mockConnections.push({
      id: "conn-usage-timeout-recovered",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      routingStatus: "eligible",
      authState: "ok",
      testStatus: "active",
    });

    getUsageForProvider
      .mockRejectedValueOnce(Object.assign(
        new Error("codex upstream timed out after 45000ms"),
        { status: 504, code: "UPSTREAM_TIMEOUT" },
      ))
      .mockResolvedValueOnce({
        plan: "pro",
        quotas: {
          weekly: {
            used: 40,
            total: 100,
            remaining: 60,
            resetAt: "2026-04-25T00:00:00.000Z",
          },
        },
      });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-usage-timeout-recovered"), {
      params: Promise.resolve({ connectionId: "conn-usage-timeout-recovered" }),
    });

    expect(response.status).toBe(200);
    expect(getUsageForProvider).toHaveBeenCalledTimes(2);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-usage-timeout-recovered",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "eligible",
        quotaState: "ok",
        usageSnapshot: expect.any(String),
      }),
    }));
  });

  it("retries generic transient fetch failures 3 times and skips without persisting account status", async () => {
    mockConnections.push({
      id: "conn-usage-fetch-failed",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      routingStatus: "eligible",
      authState: "ok",
      reasonCode: "unknown",
      reasonDetail: null,
      testStatus: "active",
    });

    getUsageForProvider
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-usage-fetch-failed?test=1"), {
      params: Promise.resolve({ connectionId: "conn-usage-fetch-failed" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      skipped: true,
      skipReason: "transient_connectivity_error",
    });
    expect(getUsageForProvider).toHaveBeenCalledTimes(3);
    expect(writeConnectionHotState).not.toHaveBeenCalled();
  });

  it("persists a fallback usage snapshot for generic usage failures", async () => {
    mockConnections.push({
      id: "conn-usage-generic-failure",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      routingStatus: "eligible",
      authState: "ok",
      testStatus: "active",
    });

    getUsageForProvider.mockRejectedValueOnce(Object.assign(
      new Error("Upstream request failed"),
      { status: 500 },
    ));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-usage-generic-failure"), {
      params: Promise.resolve({ connectionId: "conn-usage-generic-failure" }),
    });

    expect(response.status).toBe(500);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-usage-generic-failure",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "blocked",
        reasonCode: "usage_request_failed",
        usageSnapshot: expect.stringContaining("Upstream request failed"),
      }),
    }));
  });

  it("classifies 403 usage errors as auth-blocked when auth evidence is present", async () => {
    mockConnections.push({
      id: "conn-usage-throws-auth-403",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      routingStatus: "eligible",
      authState: "ok",
      testStatus: "active",
    });

    getUsageForProvider.mockRejectedValueOnce(Object.assign(
      new Error("Access denied: invalid token"),
      { status: 403 },
    ));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-usage-throws-auth-403"), {
      params: Promise.resolve({ connectionId: "conn-usage-throws-auth-403" }),
    });

    expect(response.status).toBe(403);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-usage-throws-auth-403",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "blocked",
        authState: "invalid",
        reasonCode: "auth_invalid",
        reasonDetail: "Access denied: invalid token",
        usageSnapshot: expect.any(String),
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("maps Codex 429 quota failures to canonical exhausted state", async () => {
    mockConnections.push({
      id: "conn-usage-throws-quota-429",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      refreshToken: "refresh",
      routingStatus: "eligible",
      quotaState: "ok",
      testStatus: "active",
    });

    getUsageForProvider.mockRejectedValueOnce(Object.assign(
      new Error("You have exceeded your current quota. Limit reached."),
      { status: 429 },
    ));

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-usage-throws-quota-429"), {
      params: Promise.resolve({ connectionId: "conn-usage-throws-quota-429" }),
    });

    expect(response.status).toBe(429);
    expect(writeConnectionHotState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-usage-throws-quota-429",
      provider: "codex",
      patch: expect.objectContaining({
        routingStatus: "exhausted",
        quotaState: "exhausted",
        reasonCode: "quota_exhausted",
      }),
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("returns canonical blocked model availability entries", async () => {
    mockConnections.push({
      id: "conn-availability-blocked",
      provider: "codex",
      name: "Blocked Conn",
      routingStatus: "blocked",
      authState: "invalid",
      reasonDetail: "Token revoked",
    });

    const { GET } = await import("../../src/app/api/models/availability/route.js");
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.models).toContainEqual(expect.objectContaining({
      provider: "codex",
      model: "__all",
      status: "blocked",
      connectionId: "conn-availability-blocked",
      connectionName: "Blocked Conn",
      lastError: "Token revoked",
    }));
  });

  it("returns canonical exhausted model availability entries with provider cooldown", async () => {
    const until = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    mockConnections.push({
      id: "conn-availability-exhausted",
      provider: "codex",
      email: "exhausted@example.com",
      routingStatus: "exhausted",
      quotaState: "exhausted",
      nextRetryAt: until,
      reasonDetail: "Quota exhausted",
    });

    const { GET } = await import("../../src/app/api/models/availability/route.js");
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.models).toContainEqual(expect.objectContaining({
      provider: "codex",
      model: "__all",
      status: "exhausted",
      until,
      connectionId: "conn-availability-exhausted",
      connectionName: "exhausted@example.com",
      lastError: "Quota exhausted",
    }));
  });

  it("reactivates clearCooldown only when canonical status becomes eligible", async () => {
    const lockUntil = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    mockConnections.push({
      id: "conn-clear-eligible",
      provider: "codex",
      routingStatus: "eligible",
      authState: "ok",
      quotaState: "ok",
      testStatus: "unavailable",
      modelLock_gpt4: lockUntil,
      lastError: "temporary lock",
    });

    const { POST } = await import("../../src/app/api/models/availability/route.js");
    const response = await POST(new Request("http://localhost/api/models/availability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "clearCooldown", provider: "codex", model: "__all" }),
    }));

    expect(response.status).toBe(200);
    expect(updateProviderConnection).toHaveBeenCalledWith(
      "conn-clear-eligible",
      expect.objectContaining({
        modelLock_gpt4: null,
        reasonCode: null,
        reasonDetail: null,
      })
    );
  });

  it("does not reactivate clearCooldown when canonical status remains blocked", async () => {
    const lockUntil = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    mockConnections.push({
      id: "conn-clear-blocked",
      provider: "codex",
      routingStatus: "blocked",
      authState: "invalid",
      reasonCode: "auth_invalid",
      reasonDetail: "Token revoked",
      testStatus: "blocked",
      modelLock_gpt4: lockUntil,
    });

    const { POST } = await import("../../src/app/api/models/availability/route.js");
    const response = await POST(new Request("http://localhost/api/models/availability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "clearCooldown", provider: "codex", model: "__all" }),
    }));

    expect(response.status).toBe(200);
    expect(updateProviderConnection).toHaveBeenCalledWith(
      "conn-clear-blocked",
      expect.objectContaining({
        modelLock_gpt4: null,
      })
    );
    expect(updateProviderConnection).not.toHaveBeenCalledWith(
      "conn-clear-blocked",
      expect.objectContaining({ testStatus: "active" })
    );
  });
});
