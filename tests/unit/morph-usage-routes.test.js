import { describe, expect, it, vi, beforeEach } from "vitest";

const getMorphUsageStats = vi.fn();
const getMorphRecentRequests = vi.fn();
const logMorphApiAccess = vi.fn();

vi.mock("@/lib/morphUsageDb.js", () => ({
  getMorphUsageStats,
  getMorphRecentRequests,
}));

vi.mock("@/app/api/morph/_shared.js", () => ({
  logMorphApiAccess,
}));

describe("Morph usage API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns Morph stats for a valid period", async () => {
    getMorphUsageStats.mockResolvedValue({ totalRequests: 9 });
    const { GET } = await import("../../src/app/api/morph/usage/stats/route.js");
    const response = await GET(new Request("http://localhost/api/morph/usage/stats?period=30d"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ totalRequests: 9 });
    expect(logMorphApiAccess).toHaveBeenCalledTimes(1);
    expect(getMorphUsageStats).toHaveBeenCalledWith("30d");
  });

  it("rejects invalid Morph stats periods", async () => {
    const { GET } = await import("../../src/app/api/morph/usage/stats/route.js");
    const response = await GET(new Request("http://localhost/api/morph/usage/stats?period=bad"));

    expect(response.status).toBe(400);
    expect(logMorphApiAccess).toHaveBeenCalledTimes(1);
  });

  it("returns Morph request logs with bounded limit", async () => {
    getMorphRecentRequests.mockResolvedValue([{ capability: "apply" }]);
    const { GET } = await import("../../src/app/api/morph/usage/requests/route.js");
    const response = await GET(new Request("http://localhost/api/morph/usage/requests?limit=800"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ capability: "apply" }]);
    expect(logMorphApiAccess).toHaveBeenCalledTimes(1);
    expect(getMorphRecentRequests).toHaveBeenCalledWith(500);
  });
});
