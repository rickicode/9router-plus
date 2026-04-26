import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      ok: (init?.status || 200) >= 200 && (init?.status || 200) < 300,
      json: async () => body,
    }),
  },
}));

const tempDirs = [];

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-cloud-urls-race-"));
  tempDirs.push(dir);
  return dir;
}

async function loadModulesWithTempDataDir() {
  const dataDir = await createTempDataDir();
  process.env.DATA_DIR = dataDir;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.resetModules();

  const localDb = await import("../../src/lib/localDb.js");
  const routeModule = await import("../../src/app/api/cloud-urls/route.js");

  return { dataDir, localDb, routeModule };
}

beforeEach(() => {
  process.env.NODE_ENV = "development";
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.resetModules();
  vi.restoreAllMocks();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("cloud-urls race condition", () => {
  it("should not lose updates during concurrent POST requests", async () => {
    const { localDb, routeModule } = await loadModulesWithTempDataDir();
    const { POST } = routeModule;

    const urls = [
      "https://worker1.example.com",
      "https://worker2.example.com",
      "https://worker3.example.com",
    ];

    const results = await Promise.all(
      urls.map((url) =>
        POST(
          new Request("http://localhost/api/cloud-urls", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://localhost",
              host: "localhost",
            },
            body: JSON.stringify({ url }),
          })
        )
      )
    );

    expect(results.every((response) => response.ok)).toBe(true);

    const settings = await localDb.getSettings();
    const savedUrls = settings.cloudUrls.map((entry) => entry.url);

    expect(settings.cloudUrls).toHaveLength(3);
    expect(savedUrls).toContain("https://worker1.example.com/");
    expect(savedUrls).toContain("https://worker2.example.com/");
    expect(savedUrls).toContain("https://worker3.example.com/");
  });
});
