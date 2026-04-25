import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb.js", () => ({
  getProviderConnections: vi.fn(async () => []),
  getApiKeys: vi.fn(async () => []),
  getProviderNodes: vi.fn(async () => []),
  getPricingForModel: vi.fn(async () => null),
}));

describe("getUsageStats totalRequests respects selected period", () => {
  let tempDir;

  beforeEach(() => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-stats-period-"));
    process.env.DATA_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns period-scoped totalRequests for 24h instead of lifetime total", async () => {
    const { saveRequestUsage, getUsageStats } = await import("../../src/lib/usageDb.js");

    await saveRequestUsage({
      timestamp: "2026-04-24T11:59:59.000Z",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
      cost: 1,
    });

    await saveRequestUsage({
      timestamp: "2026-04-24T12:00:00.000Z",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      tokens: { prompt_tokens: 10, completion_tokens: 2 },
      cost: 0.1,
    });

    await saveRequestUsage({
      timestamp: "2026-04-25T11:59:59.000Z",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      tokens: { prompt_tokens: 5, completion_tokens: 3 },
      cost: 0.2,
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-25T12:00:00.000Z").getTime());

    const stats = await getUsageStats("24h");

    expect(stats.totalRequests).toBe(2);
    expect(stats.totalPromptTokens).toBe(15);
    expect(stats.totalCompletionTokens).toBe(5);
    expect(stats.byProvider.anthropic.requests).toBe(2);

    nowSpy.mockRestore();
  });

  it("returns period-scoped totalRequests for 7d instead of lifetime total", async () => {
    const { saveRequestUsage, getUsageStats } = await import("../../src/lib/usageDb.js");

    await saveRequestUsage({
      timestamp: "2026-04-17T12:00:00.000Z",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
      cost: 1,
    });

    await saveRequestUsage({
      timestamp: "2026-04-20T12:00:00.000Z",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      tokens: { prompt_tokens: 10, completion_tokens: 2 },
      cost: 0.1,
    });

    await saveRequestUsage({
      timestamp: "2026-04-25T11:59:59.000Z",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      tokens: { prompt_tokens: 5, completion_tokens: 3 },
      cost: 0.2,
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-25T12:00:00.000Z").getTime());

    const stats = await getUsageStats("7d");

    expect(stats.totalRequests).toBe(2);
    expect(stats.totalPromptTokens).toBe(15);
    expect(stats.totalCompletionTokens).toBe(5);
    expect(stats.byProvider.anthropic.requests).toBe(2);

    nowSpy.mockRestore();
  });

  it("excludes future-dated entries from 24h totals and aggregation", async () => {
    const { saveRequestUsage, getUsageStats, getChartData } = await import("../../src/lib/usageDb.js");

    await saveRequestUsage({
      timestamp: "2026-04-25T10:00:00.000Z",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      tokens: { prompt_tokens: 10, completion_tokens: 2 },
      cost: 0.1,
    });

    await saveRequestUsage({
      timestamp: "2026-04-25T13:00:00.000Z",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      tokens: { prompt_tokens: 99, completion_tokens: 1 },
      cost: 9.9,
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-25T12:00:00.000Z").getTime());

    const stats = await getUsageStats("24h");
    const chart = await getChartData("24h");

    expect(stats.totalRequests).toBe(1);
    expect(stats.totalPromptTokens).toBe(10);
    expect(stats.totalCompletionTokens).toBe(2);
    expect(stats.byProvider.anthropic.requests).toBe(1);
    expect(chart.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(12);

    nowSpy.mockRestore();
  });

  it("excludes future dailySummary buckets from 7d totals and breakdowns", async () => {
    fs.writeFileSync(
      path.join(tempDir, "usage.json"),
      JSON.stringify({
        history: [],
        totalRequestsLifetime: 2,
        dailySummary: {
          "2026-04-25": {
            requests: 1,
            promptTokens: 10,
            completionTokens: 2,
            cost: 0.1,
            byProvider: { anthropic: { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0.1 } },
            byModel: {
              "claude-3-5-sonnet|anthropic": { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0.1, rawModel: "claude-3-5-sonnet", provider: "anthropic" },
            },
            byAccount: {},
            byApiKey: {},
            byEndpoint: {},
          },
          "2026-04-26": {
            requests: 1,
            promptTokens: 99,
            completionTokens: 1,
            cost: 9.9,
            byProvider: { anthropic: { requests: 1, promptTokens: 99, completionTokens: 1, cost: 9.9 } },
            byModel: {
              "claude-3-5-haiku|anthropic": { requests: 1, promptTokens: 99, completionTokens: 1, cost: 9.9, rawModel: "claude-3-5-haiku", provider: "anthropic" },
            },
            byAccount: {},
            byApiKey: {},
            byEndpoint: {},
          },
        },
      }),
    );

    const { getUsageStats } = await import("../../src/lib/usageDb.js");

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-25T12:00:00.000Z").getTime());

    const stats = await getUsageStats("7d");

    expect(stats.totalRequests).toBe(1);
    expect(stats.totalPromptTokens).toBe(10);
    expect(stats.totalCompletionTokens).toBe(2);
    expect(stats.totalCost).toBeCloseTo(0.1, 10);
    expect(stats.byProvider.anthropic.requests).toBe(1);
    expect(Object.keys(stats.byModel)).toEqual(["claude-3-5-sonnet (anthropic)"]);

    nowSpy.mockRestore();
  });

  it("excludes future dailySummary buckets from all totalRequests", async () => {
    fs.writeFileSync(
      path.join(tempDir, "usage.json"),
      JSON.stringify({
        history: [],
        totalRequestsLifetime: 2,
        dailySummary: {
          "2026-04-24": {
            requests: 1,
            promptTokens: 10,
            completionTokens: 2,
            cost: 0.1,
            byProvider: { anthropic: { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0.1 } },
            byModel: {
              "claude-3-5-sonnet|anthropic": { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0.1, rawModel: "claude-3-5-sonnet", provider: "anthropic" },
            },
            byAccount: {},
            byApiKey: {},
            byEndpoint: {},
          },
          "2026-04-26": {
            requests: 1,
            promptTokens: 99,
            completionTokens: 1,
            cost: 9.9,
            byProvider: { anthropic: { requests: 1, promptTokens: 99, completionTokens: 1, cost: 9.9 } },
            byModel: {
              "claude-3-5-haiku|anthropic": { requests: 1, promptTokens: 99, completionTokens: 1, cost: 9.9, rawModel: "claude-3-5-haiku", provider: "anthropic" },
            },
            byAccount: {},
            byApiKey: {},
            byEndpoint: {},
          },
        },
      }),
    );

    const { getUsageStats } = await import("../../src/lib/usageDb.js");

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-25T12:00:00.000Z").getTime());

    const stats = await getUsageStats("all");

    expect(stats.totalRequests).toBe(1);
    expect(stats.totalPromptTokens).toBe(10);
    expect(stats.totalCompletionTokens).toBe(2);
    expect(stats.totalCost).toBeCloseTo(0.1, 10);
    expect(stats.byProvider.anthropic.requests).toBe(1);
    expect(Object.keys(stats.byModel)).toEqual(["claude-3-5-sonnet (anthropic)"]);

    nowSpy.mockRestore();
  });
});
