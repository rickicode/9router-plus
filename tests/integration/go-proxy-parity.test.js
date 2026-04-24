import { beforeEach, describe, expect, it, vi } from "vitest";

const getProviderConnections = vi.fn();
const getSettings = vi.fn();
const getEligibleConnections = vi.fn();

const saveRequestUsage = vi.fn(async () => {});
const saveRequestDetail = vi.fn(async () => {});
const getProviderConnectionById = vi.fn(async () => ({ id: "conn-primary", provider: "openai" }));
const updateProviderConnection = vi.fn(async () => ({}));
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

vi.mock("@/lib/localDb", () => ({
  getProviderConnections,
  getSettings,
  getProviderConnectionById,
  updateProviderConnection,
}));

vi.mock("@/lib/providerHotState", () => ({
  getEligibleConnections,
  writeConnectionHotState,
  projectLegacyConnectionState,
}));

vi.mock("@/lib/usageDb", () => ({
  saveRequestUsage,
  saveRequestDetail,
}));

describe("go proxy parity and rollback verification", () => {
  beforeEach(() => {
    vi.resetModules();

    getProviderConnections.mockReset();
    getSettings.mockReset();
    getEligibleConnections.mockReset();

    saveRequestUsage.mockClear();
    saveRequestDetail.mockClear();
    getProviderConnectionById.mockClear();
    updateProviderConnection.mockClear();
    writeConnectionHotState.mockClear();
    projectLegacyConnectionState.mockClear();

    process.env.INTERNAL_PROXY_RESOLVE_TOKEN = "test-resolve-token";
    process.env.INTERNAL_PROXY_REPORT_TOKEN = "test-report-token";
  });

  it("keeps routing authority in 9router for resolve contract", async () => {
    getProviderConnections.mockResolvedValue([
      {
        id: "conn-primary",
        provider: "openai",
        priority: 1,
        isActive: true,
        routingStatus: "eligible",
        accessToken: "secret-a",
        apiKey: "secret-a",
      },
      {
        id: "conn-secondary",
        provider: "openai",
        priority: 2,
        isActive: true,
        routingStatus: "eligible",
        accessToken: "secret-b",
        apiKey: "secret-b",
      },
    ]);
    getEligibleConnections.mockImplementation(async (_providerId, connections) => connections);
    getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });

    const { POST } = await import("../../src/app/api/internal/proxy/resolve/route.js");

    const request = new Request("http://localhost/api/internal/proxy/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-auth": "test-resolve-token",
      },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4.1",
        protocolFamily: "openai",
        publicPath: "/v1/chat/completions",
      }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        owner: "9router",
        resolution: expect.objectContaining({
          chosenConnection: expect.objectContaining({ connectionId: "conn-primary" }),
          fallbackChain: [expect.objectContaining({ connectionId: "conn-secondary" })],
        }),
      }),
    );

    expect(payload.resolution.chosenConnection).not.toHaveProperty("apiKey");
    expect(payload.resolution.chosenConnection).not.toHaveProperty("accessToken");
  });

  it("keeps usage authority in 9router report ingestion so rollback path stays intact", async () => {
    const routeModule = await import("../../src/app/api/internal/proxy/report/route.js");

    const request = new Request("http://localhost/api/internal/proxy/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-auth": "test-report-token",
      },
      body: JSON.stringify({
        requestId: "req_parity_ok_1",
        provider: "openai",
        connectionId: "conn-primary",
        model: "gpt-4.1",
        protocolFamily: "openai",
        publicPath: "/v1/chat/completions",
        upstreamStatus: 200,
        latencyMs: 123,
        outcome: "ok",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
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
        endpoint: "/v1/chat/completions",
        tokens: expect.objectContaining({
          prompt_tokens: 10,
          completion_tokens: 20,
        }),
      }),
      { propagateError: true },
    );

    expect(saveRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "req_parity_ok_1",
        provider: "openai",
        model: "gpt-4.1",
        connectionId: "conn-primary",
      }),
      { propagateError: true },
    );
  });

  it("keeps rollback authority in 9router when runtime-manager verification fails", async () => {
    const { startGoProxyRuntime, restartGoProxyRuntime, getGoProxyRuntimeStatus, resetGoProxyRuntimeState } = await import("../../src/lib/goProxyRuntime.js");

    resetGoProxyRuntimeState({
      host: "127.0.0.1",
      port: 20138,
      ninerouterBaseUrl: "http://127.0.0.1:20129",
      internalResolveToken: "resolve-token",
      internalReportToken: "report-token",
      credentialsFile: "/tmp/db.json",
    });

    await startGoProxyRuntime();
    const beforeRestart = getGoProxyRuntimeStatus();

    await expect(
      restartGoProxyRuntime({
        verification: {
          ok: false,
          error: "runtime-manager unavailable",
        },
      }),
    ).rejects.toThrow("runtime-manager unavailable");

    expect(getGoProxyRuntimeStatus()).toMatchObject({
      enabled: true,
      running: true,
      status: "running",
      host: beforeRestart.host,
      port: beforeRestart.port,
      startedAt: beforeRestart.startedAt,
      lastError: "runtime-manager unavailable",
    });
  });
});
