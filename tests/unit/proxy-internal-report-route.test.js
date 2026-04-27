import { beforeEach, describe, expect, it, vi } from "vitest";

const saveRequestUsage = vi.fn(async () => {});
const saveRequestDetail = vi.fn(async () => {});
const getProviderConnectionById = vi.fn(async () => ({ id: "conn-primary", provider: "openai" }));
const updateProviderConnection = vi.fn(async () => ({}));
const getSettings = vi.fn(async () => ({
  internalProxyReportToken: "test-internal-token",
  internalProxyResolveToken: "test-resolve-token",
}));
const updateSettings = vi.fn(async () => ({}));
const writeConnectionHotState = vi.fn(async ({ patch }) => patch);
const projectLegacyConnectionState = vi.fn(() => ({ testStatus: "active" }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status ?? 200,
      body,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/usageDb", () => ({
  saveRequestUsage,
  saveRequestDetail,
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById,
  updateProviderConnection,
  getSettings,
  updateSettings,
}));

vi.mock("@/lib/providerHotState", () => ({
  writeConnectionHotState,
  projectLegacyConnectionState,
}));

describe("internal proxy report route", () => {
  beforeEach(() => {
    vi.resetModules();
    saveRequestUsage.mockClear();
    saveRequestDetail.mockClear();
    getProviderConnectionById.mockClear();
    updateProviderConnection.mockClear();
    getSettings.mockClear();
    updateSettings.mockClear();
    writeConnectionHotState.mockClear();
    projectLegacyConnectionState.mockClear();
    process.env.INTERNAL_PROXY_REPORT_TOKEN = "test-internal-token";
  });

  it("rejects report requests without valid internal auth header", async () => {
    const routeModule = await import("../../src/app/api/internal/proxy/report/route.js");

    const request = new Request("http://localhost/api/internal/proxy/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "req_unauthorized" }),
    });

    const response = await routeModule.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload).toEqual(expect.objectContaining({ ok: false, error: "unauthorized" }));
  });

  it("persists request usage+detail and canonical status when usage/quotas evidence is present", async () => {
    const routeModule = await import("../../src/app/api/internal/proxy/report/route.js");

    const request = new Request("http://localhost/api/internal/proxy/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-auth": "test-internal-token",
      },
      body: JSON.stringify({
        requestId: "req_usage_evidence_1",
        provider: "openai",
        connectionId: "conn-primary",
        model: "gpt-4.1",
        protocolFamily: "openai",
        publicPath: "/v1/chat/completions",
        upstreamStatus: 200,
        latencyMs: 212,
        outcome: "ok",
        usage: {
          prompt_tokens: 11,
          completion_tokens: 22,
        },
        quotas: {
          weekly: { used: 33, remaining: 67, total: 100 },
        },
      }),
    });

    const response = await routeModule.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true });

    expect(saveRequestUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4.1",
        connectionId: "conn-primary",
        status: "ok",
        tokens: {
          prompt_tokens: 11,
          completion_tokens: 22,
        },
      }),
      { propagateError: true }
    );

    expect(saveRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "req_usage_evidence_1",
        provider: "openai",
        model: "gpt-4.1",
        connectionId: "conn-primary",
        status: "ok",
        tokens: {
          prompt_tokens: 11,
          completion_tokens: 22,
        },
        request: expect.objectContaining({
          protocolFamily: "openai",
          publicPath: "/v1/chat/completions",
        }),
        providerResponse: expect.objectContaining({
          status: 200,
        }),
        response: expect.objectContaining({
          outcome: "ok",
        }),
      }),
      { forceFlush: false, propagateError: true }
    );

    expect(writeConnectionHotState).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-primary",
        provider: "openai",
        patch: expect.objectContaining({
          routingStatus: "eligible",
          quotaState: "ok",
          authState: "ok",
          healthStatus: "healthy",
          usageSnapshot: expect.any(String),
        }),
      })
    );
  });

  it("persists request detail for partial stream failure reports without usage", async () => {
    const routeModule = await import("../../src/app/api/internal/proxy/report/route.js");

    expect(typeof routeModule.applyProxyOutcomeReport).toBe("function");

    const request = new Request("http://localhost/api/internal/proxy/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-auth": "test-internal-token",
      },
      body: JSON.stringify({
        requestId: "req_partial_fail_1",
        provider: "openai",
        connectionId: "conn-primary",
        model: "gpt-4.1",
        protocolFamily: "openai",
        publicPath: "/v1/chat/completions",
        upstreamStatus: 500,
        latencyMs: 712,
        outcome: "error",
        error: {
          message: "stream interrupted before usage trailer",
          phase: "stream",
        },
      }),
    });

    const response = await routeModule.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true });

    expect(saveRequestUsage).not.toHaveBeenCalled();
    expect(saveRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "req_partial_fail_1",
        provider: "openai",
        model: "gpt-4.1",
        connectionId: "conn-primary",
        status: "error",
        tokens: {},
        providerResponse: expect.objectContaining({
          status: 500,
          error: expect.objectContaining({
            message: "stream interrupted before usage trailer",
            phase: "stream",
          }),
        }),
      }),
      { forceFlush: false, propagateError: true }
    );

    expect(writeConnectionHotState).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-primary",
        provider: "openai",
        patch: expect.objectContaining({
          healthStatus: "degraded",
          lastCheckedAt: expect.any(String),
          version: expect.any(Number),
        }),
      })
    );

    const [{ patch }] = writeConnectionHotState.mock.calls[0];
    expect(patch.routingStatus).toBeUndefined();
    expect(patch.quotaState).toBeUndefined();
    expect(patch.authState).toBeUndefined();
  });

  it("does not recover blocked/exhausted state on tokenless success reports", async () => {
    getProviderConnectionById.mockResolvedValueOnce({ id: "conn-primary", provider: "openai" });

    const routeModule = await import("../../src/app/api/internal/proxy/report/route.js");

    const request = new Request("http://localhost/api/internal/proxy/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-auth": "test-internal-token",
      },
      body: JSON.stringify({
        requestId: "req_tokenless_ok_1",
        provider: "openai",
        connectionId: "conn-primary",
        model: "gpt-4.1",
        protocolFamily: "openai",
        publicPath: "/v1/chat/completions",
        upstreamStatus: 200,
        latencyMs: 201,
        outcome: "ok",
      }),
    });

    const response = await routeModule.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true });

    expect(saveRequestUsage).not.toHaveBeenCalled();
    expect(writeConnectionHotState).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-primary",
        provider: "openai",
        patch: expect.objectContaining({
          usageSnapshot: "{}",
        }),
      })
    );

    const [{ patch }] = writeConnectionHotState.mock.calls[0];
    expect(patch.routingStatus).toBeUndefined();
    expect(patch.quotaState).toBeUndefined();
    expect(patch.authState).toBeUndefined();
    expect(patch.healthStatus).toBeUndefined();
  });

  it("returns explicit failure when request-detail persistence fails", async () => {
    saveRequestDetail.mockRejectedValueOnce(new Error("persist failed"));

    const routeModule = await import("../../src/app/api/internal/proxy/report/route.js");

    const request = new Request("http://localhost/api/internal/proxy/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-auth": "test-internal-token",
      },
      body: JSON.stringify({
        requestId: "req_ingest_fail_1",
        provider: "openai",
        connectionId: "conn-primary",
        outcome: "ok",
      }),
    });

    const response = await routeModule.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        error: "report_ingestion_failed",
      })
    );
    expect(payload.message).toMatch(/persist failed/i);
    expect(saveRequestDetail).toHaveBeenCalledWith(expect.any(Object), { forceFlush: false, propagateError: true });
  });

  it("treats reports with missing outcome and upstream errors as failures", async () => {
    const routeModule = await import("../../src/app/api/internal/proxy/report/route.js");

    const request = new Request("http://localhost/api/internal/proxy/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-auth": "test-internal-token",
      },
      body: JSON.stringify({
        requestId: "req_missing_outcome_http_error_1",
        provider: "openai",
        connectionId: "conn-primary",
        model: "gpt-4.1",
        protocolFamily: "openai",
        publicPath: "/v1/chat/completions",
        upstreamStatus: 500,
        latencyMs: 320,
      }),
    });

    const response = await routeModule.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true });

    expect(saveRequestUsage).not.toHaveBeenCalled();
    expect(saveRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "req_missing_outcome_http_error_1",
        status: "error",
        providerResponse: expect.objectContaining({
          status: 500,
        }),
      }),
      { forceFlush: false, propagateError: true }
    );
    expect(writeConnectionHotState).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          healthStatus: "degraded",
          lastCheckedAt: expect.any(String),
          version: expect.any(Number),
        }),
      })
    );
  });

  it("treats reports with missing outcome and explicit error payload as failures", async () => {
    const routeModule = await import("../../src/app/api/internal/proxy/report/route.js");

    const request = new Request("http://localhost/api/internal/proxy/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-auth": "test-internal-token",
      },
      body: JSON.stringify({
        requestId: "req_missing_outcome_error_payload_1",
        provider: "openai",
        connectionId: "conn-primary",
        model: "gpt-4.1",
        protocolFamily: "openai",
        publicPath: "/v1/chat/completions",
        error: {
          message: "upstream aborted",
          code: "upstream_abort",
        },
      }),
    });

    const response = await routeModule.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true });

    expect(saveRequestUsage).not.toHaveBeenCalled();
    expect(saveRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "req_missing_outcome_error_payload_1",
        status: "error",
        providerResponse: expect.objectContaining({
          status: null,
          error: expect.objectContaining({
            message: "upstream aborted",
            code: "upstream_abort",
          }),
        }),
      }),
      { forceFlush: false, propagateError: true }
    );
    expect(writeConnectionHotState).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          healthStatus: "degraded",
          lastCheckedAt: expect.any(String),
          version: expect.any(Number),
        }),
      })
    );
  });

  it("returns explicit failure when usage persistence fails", async () => {
    saveRequestUsage.mockRejectedValueOnce(new Error("usage persist failed"));

    const routeModule = await import("../../src/app/api/internal/proxy/report/route.js");

    const request = new Request("http://localhost/api/internal/proxy/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-auth": "test-internal-token",
      },
      body: JSON.stringify({
        requestId: "req_usage_fail_1",
        provider: "openai",
        connectionId: "conn-primary",
        model: "gpt-4.1",
        protocolFamily: "openai",
        publicPath: "/v1/chat/completions",
        upstreamStatus: 200,
        outcome: "ok",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
        },
      }),
    });

    const response = await routeModule.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        error: "report_ingestion_failed",
      })
    );
    expect(payload.message).toMatch(/usage persist failed/i);
    expect(saveRequestDetail).not.toHaveBeenCalled();
  });

});
