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

describe("usageDb write serialization", () => {
  let tempDir;

  beforeEach(() => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-db-serialize-"));
    process.env.DATA_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("serializes overlapping saveRequestUsage calls and preserves both entries", async () => {
    const { getUsageDb, saveRequestUsage } = await import("../../src/lib/usageDb.js");
    const db = await getUsageDb();

    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    const writeSpy = vi.spyOn(db, "write").mockImplementation(async () => {
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeWrites -= 1;
    });

    await Promise.all([
      saveRequestUsage({ model: "gpt-4", provider: "openai", timestamp: "2026-04-25T12:00:00.000Z" }),
      saveRequestUsage({ model: "gpt-4.1", provider: "openai", timestamp: "2026-04-25T12:00:01.000Z" }),
    ]);

    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(maxConcurrentWrites).toBe(1);
    expect(db.data.history).toHaveLength(2);
    expect(db.data.history.map((entry) => entry.model)).toEqual(["gpt-4", "gpt-4.1"]);
    expect(db.data.totalRequestsLifetime).toBe(2);
  });
});
