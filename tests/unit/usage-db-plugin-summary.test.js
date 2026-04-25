import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb.js", () => ({
  getProviderConnections: vi.fn(async () => []),
  getApiKeys: vi.fn(async () => []),
  getProviderNodes: vi.fn(async () => []),
}));

describe("getPluginUsageSummary period semantics", () => {
  it("returns zero totals for today when there is no data", async () => {
    const { getPluginUsageSummary } = await import("../../src/lib/usageDb.js");

    const summary = getPluginUsageSummary({
      period: "today",
      history: [],
      dailySummary: {},
      now: new Date("2026-04-25T12:00:00.000Z"),
    });

    expect(summary).toMatchObject({
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    });
  });

  it("uses only the current local dailySummary bucket for today", async () => {
    const { getPluginUsageSummary } = await import("../../src/lib/usageDb.js");

    const summary = getPluginUsageSummary({
      period: "today",
      history: [
        {
          timestamp: "2026-04-24T23:30:00.000Z",
          tokens: { prompt_tokens: 9, completion_tokens: 4 },
          cost: 0.25,
        },
        {
          timestamp: "2026-04-25T02:00:00.000Z",
          tokens: { prompt_tokens: 50, completion_tokens: 10 },
          cost: 0.5,
        },
      ],
      dailySummary: {
        "2026-04-25": {
          requests: 1,
          promptTokens: 9,
          completionTokens: 4,
          cost: 0.25,
        },
      },
      now: new Date("2026-04-25T12:00:00.000Z"),
    });

    expect(summary).toMatchObject({
      requests: 1,
      promptTokens: 9,
      completionTokens: 4,
      cost: 0.25,
    });
  });

  it("uses a rolling last24h window from valid history timestamps", async () => {
    const { getPluginUsageSummary } = await import("../../src/lib/usageDb.js");

    const summary = getPluginUsageSummary({
      period: "last24h",
      history: [
        {
          timestamp: "2026-04-24T11:59:59.000Z",
          tokens: { prompt_tokens: 100, completion_tokens: 20 },
          cost: 1,
        },
        {
          timestamp: "2026-04-24T12:00:00.000Z",
          tokens: { prompt_tokens: 10, completion_tokens: 2 },
          cost: 0.1,
        },
        {
          timestamp: "2026-04-25T11:59:59.000Z",
          tokens: { prompt_tokens: 5, completion_tokens: 3 },
          cost: 0.2,
        },
        {
          timestamp: "not-a-timestamp",
          tokens: { prompt_tokens: 999, completion_tokens: 999 },
          cost: 9.99,
        },
      ],
      dailySummary: {
        "2026-04-24": {
          requests: 2,
          promptTokens: 110,
          completionTokens: 22,
          cost: 1.1,
        },
        "2026-04-25": {
          requests: 1,
          promptTokens: 5,
          completionTokens: 3,
          cost: 0.2,
        },
      },
      now: new Date("2026-04-25T12:00:00.000Z"),
    });

    expect(summary).toMatchObject({
      requests: 2,
      promptTokens: 15,
      completionTokens: 5,
    });
    expect(summary.cost).toBeCloseTo(0.3, 10);
  });

  it("sums the last seven local date buckets including today", async () => {
    const { getPluginUsageSummary } = await import("../../src/lib/usageDb.js");

    const summary = getPluginUsageSummary({
      period: "7d",
      history: [],
      dailySummary: {
        "2026-04-18": { requests: 99, promptTokens: 99, completionTokens: 99, cost: 9.9 },
        "2026-04-19": { requests: 1, promptTokens: 10, completionTokens: 1, cost: 0.1 },
        "2026-04-20": { requests: 2, promptTokens: 20, completionTokens: 2, cost: 0.2 },
        "2026-04-21": { requests: 3, promptTokens: 30, completionTokens: 3, cost: 0.3 },
        "2026-04-22": { requests: 4, promptTokens: 40, completionTokens: 4, cost: 0.4 },
        "2026-04-23": { requests: 5, promptTokens: 50, completionTokens: 5, cost: 0.5 },
        "2026-04-24": { requests: 6, promptTokens: 60, completionTokens: 6, cost: 0.6 },
        "2026-04-25": { requests: 7, promptTokens: 70, completionTokens: 7, cost: 0.7 },
      },
      now: new Date("2026-04-25T12:00:00.000Z"),
    });

    expect(summary).toMatchObject({
      requests: 28,
      promptTokens: 280,
      completionTokens: 28,
      cost: 2.8,
    });
  });
});
