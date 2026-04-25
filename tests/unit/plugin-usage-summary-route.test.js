import { beforeEach, describe, expect, it, vi } from "vitest";

const getUsageDb = vi.fn();
const getPluginUsageSummary = vi.fn();

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/usageDb.js", () => ({
  getUsageDb,
  getPluginUsageSummary,
}));

describe("plugin usage summary route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUsageDb.mockResolvedValue({
      data: {
        history: [{ id: 1 }],
        dailySummary: { "2026-04-25": { requests: 1 } },
      },
    });
    getPluginUsageSummary.mockReturnValue({
      requests: 1,
      promptTokens: 2,
      completionTokens: 3,
      cost: 0.4,
    });
  });

  it("defaults period to today and returns the narrow contract", async () => {
    const { GET } = await import("../../src/app/api/plugin/usage-summary/route.js");

    const response = await GET(new Request("http://localhost/api/plugin/usage-summary"));

    expect(response.status).toBe(200);
    expect(getPluginUsageSummary).toHaveBeenCalledWith({
      period: "today",
      history: [{ id: 1 }],
      dailySummary: { "2026-04-25": { requests: 1 } },
      now: expect.any(Date),
    });
    expect(response.body).toEqual({
      ok: true,
      period: "today",
      generatedAt: expect.any(String),
      summary: {
        requests: 1,
        promptTokens: 2,
        completionTokens: 3,
        cost: 0.4,
      },
    });
  });

  it("accepts last24h and 7d periods", async () => {
    const { GET } = await import("../../src/app/api/plugin/usage-summary/route.js");

    const last24hResponse = await GET(new Request("http://localhost/api/plugin/usage-summary?period=last24h"));
    const sevenDayResponse = await GET(new Request("http://localhost/api/plugin/usage-summary?period=7d"));

    expect(last24hResponse.status).toBe(200);
    expect(sevenDayResponse.status).toBe(200);
    expect(getPluginUsageSummary).toHaveBeenNthCalledWith(1, {
      period: "last24h",
      history: [{ id: 1 }],
      dailySummary: { "2026-04-25": { requests: 1 } },
      now: expect.any(Date),
    });
    expect(getPluginUsageSummary).toHaveBeenNthCalledWith(2, {
      period: "7d",
      history: [{ id: 1 }],
      dailySummary: { "2026-04-25": { requests: 1 } },
      now: expect.any(Date),
    });
  });

  it("returns 400 for an invalid period", async () => {
    const { GET } = await import("../../src/app/api/plugin/usage-summary/route.js");

    const response = await GET(new Request("http://localhost/api/plugin/usage-summary?period=30d"));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: "Invalid period",
    });
    expect(getPluginUsageSummary).not.toHaveBeenCalled();
  });

  it("returns 500 when summary fetch fails unexpectedly", async () => {
    getUsageDb.mockRejectedValueOnce(new Error("boom"));
    const { GET } = await import("../../src/app/api/plugin/usage-summary/route.js");

    const response = await GET(new Request("http://localhost/api/plugin/usage-summary"));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      error: "Failed to fetch plugin usage summary",
    });
  });

  it("returns 500 when request.url is malformed or non-absolute", async () => {
    const { GET } = await import("../../src/app/api/plugin/usage-summary/route.js");

    const response = await GET({ url: "/api/plugin/usage-summary?period=today" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      error: "Failed to fetch plugin usage summary",
    });
    expect(getUsageDb).not.toHaveBeenCalled();
    expect(getPluginUsageSummary).not.toHaveBeenCalled();
  });

  it("normalizes malformed history and dailySummary shapes before building the summary", async () => {
    getUsageDb.mockResolvedValueOnce({
      data: {
        history: {},
        dailySummary: [],
      },
    });
    const { GET } = await import("../../src/app/api/plugin/usage-summary/route.js");

    const response = await GET(new Request("http://localhost/api/plugin/usage-summary"));

    expect(response.status).toBe(200);
    expect(getPluginUsageSummary).toHaveBeenCalledWith({
      period: "today",
      history: [],
      dailySummary: {},
      now: expect.any(Date),
    });
    expect(response.body).toEqual({
      ok: true,
      period: "today",
      generatedAt: expect.any(String),
      summary: {
        requests: 1,
        promptTokens: 2,
        completionTokens: 3,
        cost: 0.4,
      },
    });
  });

  it("normalizes missing db data before building the summary", async () => {
    getUsageDb.mockResolvedValueOnce({});
    const { GET } = await import("../../src/app/api/plugin/usage-summary/route.js");

    await GET(new Request("http://localhost/api/plugin/usage-summary?period=7d"));

    expect(getPluginUsageSummary).toHaveBeenCalledWith({
      period: "7d",
      history: [],
      dailySummary: {},
      now: expect.any(Date),
    });
  });
});
