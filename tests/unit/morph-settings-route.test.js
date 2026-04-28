import { beforeEach, describe, expect, it, vi } from "vitest";

const getSettings = vi.fn();
const updateSettings = vi.fn();
const refreshSchedule = vi.fn();
const readRuntimeConfig = vi.fn();
const applyOutboundProxyEnv = vi.fn();
const isCloudEnabled = vi.fn();
const syncToCloud = vi.fn();

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

vi.mock("@/lib/localDb", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getSettings,
    updateSettings,
    isCloudEnabled,
  };
});

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv,
}));

vi.mock("@/lib/quotaRefreshScheduler", () => ({
  getQuotaRefreshScheduler: () => ({
    refreshSchedule,
  }),
}));

vi.mock("@/lib/runtimeConfig", () => ({
  readRuntimeConfig,
}));

vi.mock("@/lib/cloudSync", () => ({
  syncToCloud,
}));

describe("/api/settings morph settings", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    readRuntimeConfig.mockResolvedValue({ redis: {} });
    isCloudEnabled.mockResolvedValue(false);
    syncToCloud.mockResolvedValue(undefined);
  });

  it("GET returns morph defaults when not yet configured", async () => {
    getSettings.mockResolvedValue({
      cloudEnabled: false,
      morph: {
        baseUrl: "https://api.morphllm.com",
        apiKeys: [],
        roundRobinEnabled: false,
      },
    });

    const { GET } = await import("../../src/app/api/settings/route.js");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.morph).toEqual({
      baseUrl: "https://api.morphllm.com",
      apiKeys: [],
      roundRobinEnabled: false,
    });
  });

  it("PATCH updates morph fields and GET returns updated values", async () => {
    const initialSettings = {
      cloudEnabled: false,
      morph: {
        baseUrl: "https://api.morphllm.com",
        apiKeys: [],
        roundRobinEnabled: false,
      },
    };
    const updatedSettings = {
      ...initialSettings,
      morph: {
        baseUrl: "https://proxy.example.com",
        apiKeys: [
          { email: "one@example.com", key: "mk-1", status: "active", isExhausted: false, lastCheckedAt: "2026-04-28T00:00:00.000Z", lastError: "" },
          { email: "two@example.com", key: "mk-2", status: "inactive", isExhausted: false, lastCheckedAt: "2026-04-28T00:00:01.000Z", lastError: "invalid api key" },
        ],
        roundRobinEnabled: true,
      },
    };

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("invalid api key", { status: 401 }));
    getSettings.mockResolvedValueOnce(initialSettings).mockResolvedValueOnce(updatedSettings);
    updateSettings.mockResolvedValue(updatedSettings);

    const { PATCH, GET } = await import("../../src/app/api/settings/route.js");
    const patchResponse = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          morph: {
            baseUrl: "https://proxy.example.com",
            apiKeys: [
              { email: "one@example.com", key: "mk-1", status: "inactive", isExhausted: false, lastCheckedAt: null, lastError: "" },
              { email: "two@example.com", key: "mk-2", status: "inactive", isExhausted: false, lastCheckedAt: null, lastError: "" },
            ],
            roundRobinEnabled: true,
          },
        }),
      })
    );

    expect(patchResponse.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      morph: {
        baseUrl: "https://proxy.example.com",
        apiKeys: [
          { email: "one@example.com", key: "mk-1", status: "active", isExhausted: false, lastCheckedAt: expect.any(String), lastError: "" },
          { email: "two@example.com", key: "mk-2", status: "inactive", isExhausted: false, lastCheckedAt: expect.any(String), lastError: "invalid api key" },
        ],
        roundRobinEnabled: true,
      },
    });

    const getResponse = await GET();
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.morph).toEqual({
      baseUrl: "https://proxy.example.com",
      apiKeys: [
        { email: "one@example.com", key: "mk-1", status: "active", isExhausted: false, lastCheckedAt: "2026-04-28T00:00:00.000Z", lastError: "" },
        { email: "two@example.com", key: "mk-2", status: "inactive", isExhausted: false, lastCheckedAt: "2026-04-28T00:00:01.000Z", lastError: "invalid api key" },
      ],
      roundRobinEnabled: true,
    });
  });

  it("PATCH returns 400 for invalid baseUrl before Morph key validation runs", async () => {
    getSettings.mockResolvedValue({
      cloudEnabled: false,
      morph: {
        baseUrl: "https://api.morphllm.com",
        apiKeys: [{ email: "one@example.com", key: "mk-1", status: "active", isExhausted: false, lastCheckedAt: null, lastError: "" }],
        roundRobinEnabled: false,
      },
    });

    const { PATCH } = await import("../../src/app/api/settings/route.js");
    const response = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          morph: {
            baseUrl: "not-a-url",
            apiKeys: [{ email: "one@example.com", key: "mk-1", status: "inactive", isExhausted: false, lastCheckedAt: null, lastError: "" }],
          },
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Morph base URL must be a valid absolute http(s) URL",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("PATCH keeps keys retryable when Morph validation fails transiently", async () => {
    const currentSettings = {
      cloudEnabled: false,
      morph: {
        baseUrl: "https://api.morphllm.com",
        apiKeys: [],
        roundRobinEnabled: false,
      },
    };

    getSettings.mockResolvedValue(currentSettings);
    fetch.mockRejectedValueOnce(new Error("socket hang up"));
    updateSettings.mockImplementation(async (updates) => ({
      ...currentSettings,
      ...updates,
    }));

    const { PATCH } = await import("../../src/app/api/settings/route.js");
    const response = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          morph: {
            baseUrl: "https://api.morphllm.com",
            apiKeys: [{ email: "one@example.com", key: "mk-1", status: "inactive", isExhausted: false, lastCheckedAt: null, lastError: "" }],
            roundRobinEnabled: true,
          },
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      morph: {
        baseUrl: "https://api.morphllm.com",
        apiKeys: [
          {
            email: "one@example.com",
            key: "mk-1",
            status: "unknown",
            isExhausted: false,
            lastCheckedAt: expect.any(String),
            lastError: "socket hang up",
          },
        ],
        roundRobinEnabled: true,
      },
    });
  });

  it("partial PATCH preserves unset morph fields", async () => {
    const currentSettings = {
      cloudEnabled: false,
      morph: {
        baseUrl: "https://persisted.example.com",
        apiKeys: [{ email: "keep@example.com", key: "mk-keep", status: "active", isExhausted: false, lastCheckedAt: "2026-04-28T00:00:00.000Z", lastError: "" }],
        roundRobinEnabled: false,
      },
    };

    getSettings.mockResolvedValue(currentSettings);
    updateSettings.mockResolvedValue({
      ...currentSettings,
      morph: {
        ...currentSettings.morph,
        roundRobinEnabled: true,
      },
    });

    const { PATCH } = await import("../../src/app/api/settings/route.js");
    const response = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ morph: { roundRobinEnabled: true } }),
      })
    );

    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      morph: {
        baseUrl: "https://persisted.example.com",
        apiKeys: [{ email: "keep@example.com", key: "mk-keep", status: "active", isExhausted: false, lastCheckedAt: "2026-04-28T00:00:00.000Z", lastError: "" }],
        roundRobinEnabled: true,
      },
    });
    expect(response.body.morph).toEqual({
      baseUrl: "https://persisted.example.com",
      apiKeys: [{ email: "keep@example.com", key: "mk-keep", status: "active", isExhausted: false, lastCheckedAt: "2026-04-28T00:00:00.000Z", lastError: "" }],
      roundRobinEnabled: true,
    });
  });

  it("PATCH with invalid baseUrl returns 400", async () => {
    getSettings.mockResolvedValue({
      cloudEnabled: false,
      morph: {
        baseUrl: "https://api.morphllm.com",
        apiKeys: [],
        roundRobinEnabled: false,
      },
    });
    updateSettings.mockRejectedValue(new Error("Morph base URL must be a valid absolute http(s) URL"));

    const { PATCH } = await import("../../src/app/api/settings/route.js");
    const response = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ morph: { baseUrl: "not-a-url" } }),
      })
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Morph base URL must be a valid absolute http(s) URL",
    });
  });

  it("PATCH morph does not affect unrelated settings", async () => {
    const currentSettings = {
      cloudEnabled: false,
      providerStrategies: { openai: "priority" },
      roundRobin: true,
      morph: {
        baseUrl: "https://persisted.example.com",
        apiKeys: [{ email: "keep@example.com", key: "mk-keep", status: "active", isExhausted: false, lastCheckedAt: "2026-04-28T00:00:00.000Z", lastError: "" }],
        roundRobinEnabled: false,
      },
    };

    getSettings.mockResolvedValue(currentSettings);
    updateSettings.mockImplementation(async (updates) => ({
      ...currentSettings,
      ...updates,
    }));

    const { PATCH } = await import("../../src/app/api/settings/route.js");
    const response = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ morph: { roundRobinEnabled: true } }),
      })
    );

    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      morph: {
        baseUrl: "https://persisted.example.com",
        apiKeys: [{ email: "keep@example.com", key: "mk-keep", status: "active", isExhausted: false, lastCheckedAt: "2026-04-28T00:00:00.000Z", lastError: "" }],
        roundRobinEnabled: true,
      },
    });
    expect(response.body.providerStrategies).toEqual({ openai: "priority" });
    expect(response.body.roundRobin).toBe(true);
  });
});
