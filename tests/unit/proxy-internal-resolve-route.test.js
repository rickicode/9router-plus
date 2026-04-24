import { beforeEach, describe, expect, it, vi } from "vitest";

const getProviderConnections = vi.fn();
const getEligibleConnections = vi.fn();
const getSettings = vi.fn();

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
}));

vi.mock("@/lib/providerHotState", () => ({
  getEligibleConnections,
}));

vi.mock("@/shared/constants/providers.js", async () => {
  const actual = await import("../../src/shared/constants/providers.js");
  return actual;
});

describe("internal proxy resolve route", () => {
  beforeEach(() => {
    vi.resetModules();
    getProviderConnections.mockReset();
    getEligibleConnections.mockReset();
    getSettings.mockReset();
    process.env.INTERNAL_PROXY_RESOLVE_TOKEN = "test-resolve-token";
    process.env.INTERNAL_PROXY_REPORT_TOKEN = "test-report-token";
    delete process.env.GO_PROXY_RESOLVE_CACHE_TTL_SECONDS;
  });

  it("rejects resolve requests without valid internal auth header", async () => {
    const { POST } = await import("../../src/app/api/internal/proxy/resolve/route.js");

    const request = new Request("http://localhost/api/internal/proxy/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4.1",
        protocolFamily: "openai",
        publicPath: "/v1/chat/completions",
      }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload).toEqual(expect.objectContaining({ ok: false, error: "unauthorized" }));
  });

  it("rejects resolve requests when resolve token is unset even if report token exists", async () => {
    delete process.env.INTERNAL_PROXY_RESOLVE_TOKEN;
    process.env.INTERNAL_PROXY_REPORT_TOKEN = "test-report-token";

    const { POST } = await import("../../src/app/api/internal/proxy/resolve/route.js");

    const request = new Request("http://localhost/api/internal/proxy/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-auth": "test-report-token",
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

    expect(response.status).toBe(401);
    expect(payload).toEqual(expect.objectContaining({ ok: false, error: "unauthorized" }));
  });

  it("accepts resolve requests with valid resolve token only", async () => {
    getProviderConnections.mockResolvedValue([
      {
        id: "conn-primary",
        provider: "openai",
        priority: 1,
        isActive: true,
        routingStatus: "eligible",
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

    expect(response.status).toBe(200);
  });

  it("returns chosen connection plus ordered fallback chain with bounded TTL", async () => {
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
    process.env.GO_PROXY_RESOLVE_CACHE_TTL_SECONDS = "999";

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
          provider: "openai",
          model: "gpt-4.1",
          protocolFamily: "openai",
          publicPath: "/v1/chat/completions",
          ttlSeconds: 10,
          chosenConnection: expect.objectContaining({
            connectionId: "conn-primary",
            provider: "openai",
          }),
          fallbackChain: [
            expect.objectContaining({
              connectionId: "conn-secondary",
              provider: "openai",
            }),
          ],
        }),
      })
    );

    expect(payload.resolution.chosenConnection).not.toHaveProperty("apiKey");
    expect(payload.resolution.chosenConnection).not.toHaveProperty("accessToken");
  });

  it("rejects invalid protocol/public path pair", async () => {
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
        protocolFamily: "anthropic",
        publicPath: "/v1/chat/completions",
      }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        error: "invalid_route_contract",
      })
    );
  });
});
