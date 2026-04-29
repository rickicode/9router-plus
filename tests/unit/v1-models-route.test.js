import { beforeEach, describe, expect, it, vi } from "vitest";

const getProviderConnections = vi.fn();
const getCombos = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getProviderConnections,
  getCombos,
}));

vi.mock("@/shared/constants/models", () => ({
  PROVIDER_MODELS: {
    openai: [],
    anthropic: [],
  },
  PROVIDER_ID_TO_ALIAS: {
    "openai-compatible-demo": "openai",
    "anthropic-compatible-demo": "anthropic",
  },
}));

vi.mock("@/shared/constants/providers", () => ({
  getProviderAlias: (providerId) => {
    if (providerId === "openai-compatible-demo") return "openai-demo";
    if (providerId === "anthropic-compatible-demo") return "anthropic-demo";
    return providerId;
  },
  isOpenAICompatibleProvider: (providerId) => providerId.startsWith("openai-compatible-"),
  isAnthropicCompatibleProvider: (providerId) => providerId.startsWith("anthropic-compatible-"),
}));

describe("/api/v1/models route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getProviderConnections.mockResolvedValue([]);
    getCombos.mockResolvedValue([]);
    global.fetch = vi.fn();
  });

  it("uses Anthropic-compatible headers without Authorization when fetching remote models", async () => {
    getProviderConnections.mockResolvedValue([
      {
        provider: "anthropic-compatible-demo",
        isActive: true,
        apiKey: "anthropic-key",
        providerSpecificData: { baseUrl: "https://anthropic-proxy.example/v1/messages" },
      },
    ]);
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "claude-compatible-1" }] }),
    });

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const response = await GET();
    const payload = await response.json();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://anthropic-proxy.example/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "anthropic-key",
          "anthropic-version": "2023-06-01",
        },
      })
    );
    expect(payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "anthropic-demo/claude-compatible-1" }),
      ])
    );
  });

  it("fetches compatible provider model lists in parallel and keeps successful results when one fails", async () => {
    getProviderConnections.mockResolvedValue([
      {
        provider: "openai-compatible-demo",
        isActive: true,
        apiKey: "openai-key",
        providerSpecificData: { baseUrl: "https://openai-proxy.example/v1" },
      },
      {
        provider: "anthropic-compatible-demo",
        isActive: true,
        apiKey: "anthropic-key",
        providerSpecificData: { baseUrl: "https://anthropic-proxy.example/v1" },
      },
    ]);

    let openaiResolved = false;
    let anthropicStartedAfterOpenaiResolved = false;

    global.fetch.mockImplementation((url) => {
      if (url.includes("openai-proxy")) {
        return new Promise((resolve) => {
          setTimeout(() => {
            openaiResolved = true;
            resolve({
              ok: true,
              json: async () => ({ data: [{ id: "gpt-4.1-mini" }] }),
            });
          }, 20);
        });
      }

      if (url.includes("anthropic-proxy")) {
        anthropicStartedAfterOpenaiResolved = openaiResolved;
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const response = await GET();
    const payload = await response.json();

    expect(anthropicStartedAfterOpenaiResolved).toBe(false);
    expect(payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openai-demo/gpt-4.1-mini" }),
      ])
    );
    expect(payload.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "anthropic-demo/claude-compatible-1" }),
      ])
    );
  });

  it("deduplicates in-flight remote discovery for identical compatible providers", async () => {
    getProviderConnections.mockResolvedValue([
      {
        provider: "openai-compatible-demo",
        isActive: true,
        apiKey: "shared-openai-key",
        providerSpecificData: { baseUrl: "https://openai-proxy.example/v1" },
      },
    ]);

    let releaseFetch;
    global.fetch.mockImplementation(() => new Promise((resolve) => {
      releaseFetch = () => resolve({
        ok: true,
        json: async () => ({ data: [{ id: "gpt-4.1-mini" }] }),
      });
    }));

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const firstResponsePromise = GET();
    const secondResponsePromise = GET();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    releaseFetch();

    const [firstResponse, secondResponse] = await Promise.all([firstResponsePromise, secondResponsePromise]);
    const firstPayload = await firstResponse.json();
    const secondPayload = await secondResponse.json();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(firstPayload.data).toEqual(secondPayload.data);
  });

  it("reuses the final response cache for repeated requests with unchanged inputs", async () => {
    getProviderConnections.mockResolvedValue([
      {
        provider: "openai-compatible-demo",
        isActive: true,
        apiKey: "openai-key",
        providerSpecificData: { baseUrl: "https://openai-proxy.example/v1" },
      },
    ]);
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4.1-mini" }] }),
    });

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const firstResponse = await GET();
    const secondResponse = await GET();
    const firstPayload = await firstResponse.json();
    const secondPayload = await secondResponse.json();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(getProviderConnections).toHaveBeenCalledTimes(2);
    expect(getCombos).toHaveBeenCalledTimes(2);
    expect(firstPayload.data).toEqual(secondPayload.data);
  });
});
