import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-morph-usage-"));
  tempDirs.push(dir);
  process.env.DATA_DIR = dir;
  return dir;
}

describe("morph usage pricing", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    await createTempDataDir();
    vi.resetModules();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.DATA_DIR;
    while (tempDirs.length > 0) {
      await fs.rm(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("calculates credits from official Morph pricing", async () => {
    const { calculateMorphCredits } = await import("../../src/lib/morphUsageDb.js");
    const result = calculateMorphCredits({
      capability: "apply",
      model: "morph-v3-large",
      tokens: { prompt_tokens: 1000, completion_tokens: 500 },
    });

    expect(result.model).toBe("morph-v3-large");
    expect(result.dollars).toBeCloseTo(0.00185, 8);
    expect(result.credits).toBeCloseTo(185, 5);
  });

  it("falls back to capability default model pricing", async () => {
    const { calculateMorphCredits } = await import("../../src/lib/morphUsageDb.js");
    const result = calculateMorphCredits({
      capability: "compact",
      model: null,
      tokens: { input_tokens: 2000, output_tokens: 1000 },
    });

    expect(result.model).toBe("morph-compactor");
    expect(result.credits).toBeCloseTo(90, 5);
  });

  it("aggregates auto compact impact separately from Morph request totals", async () => {
    const { saveMorphUsage, getMorphUsageStats, resetMorphUsageDbForTests } = await import("../../src/lib/morphUsageDb.js");
    resetMorphUsageDbForTests();

    await saveMorphUsage({
      capability: "apply",
      entrypoint: "/morphllm/v1/chat/completions",
      model: "morph-v3-large",
      status: "ok",
      tokens: { input_tokens: 100, output_tokens: 50 },
      apiKeyLabel: "owner@example.com",
      timestamp: "2026-05-01T11:00:00.000Z",
    });
    await saveMorphUsage({
      capability: "auto-compact",
      entrypoint: "/internal/auto-compact",
      category: "auto_compact",
      status: "ok",
      tokens: { input_tokens: 0, output_tokens: 0 },
      autoCompactStats: {
        applied: true,
        originalMessageCount: 8,
        compactedMessageCount: 8,
        originalChars: 2000,
        compactedChars: 800,
        savedChars: 1200,
        originalTokensEstimate: 500,
        compactedTokensEstimate: 200,
        savedTokensEstimate: 300,
        reductionPercent: 60,
        compressionRatioTarget: 0.5,
      },
      timestamp: "2026-05-01T11:05:00.000Z",
    });

    const stats = await getMorphUsageStats("24h");
    expect(stats.totalRequests).toBe(1);
    expect(stats.totalRequestsLifetime).toBe(1);
    expect(stats.autoCompact).toMatchObject({
      appliedCount: 1,
      savedTokensEstimate: 300,
      savedChars: 1200,
      avgReductionPercent: 60,
      maxReductionPercent: 60,
      totalOriginalTokensEstimate: 500,
      totalCompactedTokensEstimate: 200,
    });
    expect(stats.autoCompact.trend).toEqual([expect.objectContaining({
      date: "2026-05-01",
      appliedCount: 1,
      savedTokensEstimate: 300,
      avgReductionPercent: 60,
    })]);
    expect(stats.recentRequests).toHaveLength(1);
  });
});
