import { beforeEach, describe, expect, it, vi } from "vitest";

const getKnownProviders = vi.fn(async () => []);
const getRequestDetails = vi.fn(async () => ({ details: [] }));
const getProviderNodes = vi.fn(async () => []);

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/requestDetailsDb", () => ({
  getKnownProviders,
  getRequestDetails,
}));

vi.mock("@/lib/localDb", () => ({
  getProviderNodes,
}));

vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    openai: { name: "OpenAI" },
    anthropic: { name: "Anthropic" },
  },
  getProviderByAlias: vi.fn((providerId) => ({
    openai: { name: "OpenAI" },
    anthropic: { name: "Anthropic" },
  }[providerId] || null)),
}));

describe("request details providers route", () => {
  beforeEach(() => {
    vi.resetModules();
    getKnownProviders.mockReset();
    getRequestDetails.mockReset();
    getProviderNodes.mockReset();
    getKnownProviders.mockResolvedValue([]);
    getRequestDetails.mockResolvedValue({ details: [] });
    getProviderNodes.mockResolvedValue([]);
  });

  it("uses provider summary helper instead of loading all request details", async () => {
    getKnownProviders.mockResolvedValue(["openai", "custom-node", "anthropic"]);
    getProviderNodes.mockResolvedValue([
      { id: "custom-node", name: "Custom Node" },
    ]);

    const { GET } = await import("../../src/app/api/usage/providers/route.js");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(getKnownProviders).toHaveBeenCalledTimes(1);
    expect(getRequestDetails).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      providers: [
        { id: "openai", name: "OpenAI" },
        { id: "custom-node", name: "Custom Node" },
        { id: "anthropic", name: "Anthropic" },
      ],
    });
  });

  it("returns 500 when provider summary lookup fails", async () => {
    getKnownProviders.mockRejectedValue(new Error("boom"));

    const { GET } = await import("../../src/app/api/usage/providers/route.js");
    const response = await GET();

    expect(response.status).toBe(500);
    expect(getKnownProviders).toHaveBeenCalledTimes(1);
    expect(getRequestDetails).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Failed to fetch providers",
    });
  });
});

describe("applyProxyOutcomeReport request detail persistence", () => {
  it("preserves propagateError intent without forcing a detail flush", async () => {
    vi.resetModules();

    const saveRequestDetailMock = vi.fn(async () => {});
    const saveRequestUsageMock = vi.fn(async () => {});

    vi.doMock("@/lib/usageDb", () => ({
      saveRequestDetail: saveRequestDetailMock,
      saveRequestUsage: saveRequestUsageMock,
    }));

    vi.doMock("@/lib/localDb", () => ({
      getProviderConnectionById: vi.fn(async () => null),
      updateProviderConnection: vi.fn(async () => null),
    }));

    vi.doMock("@/lib/providerHotState", () => ({
      projectLegacyConnectionState: vi.fn(() => null),
      writeConnectionHotState: vi.fn(async () => null),
    }));

    const { applyProxyOutcomeReport } = await import("../../src/lib/usageStatus.js");

    await applyProxyOutcomeReport({
      provider: "openai",
      model: "gpt-4o-mini",
      outcome: "ok",
      upstreamStatus: 200,
      requestId: "req-123",
      observedAt: "2026-04-25T00:00:00.000Z",
    });

    expect(saveRequestDetailMock).toHaveBeenCalledTimes(1);
    expect(saveRequestDetailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "req-123",
        provider: "openai",
        model: "gpt-4o-mini",
      }),
      { forceFlush: false, propagateError: true },
    );
  });
});
