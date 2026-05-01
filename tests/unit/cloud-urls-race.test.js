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

async function seedCloudUrl(localDb, overrides = {}) {
  await localDb.atomicUpdateSettings((settings) => ({
    ...settings,
    cloudUrls: [
      {
        id: "worker-1",
        url: "https://worker1.example.com/",
        name: "Worker 1",
        secret: "test-cloud-secret",
        ...overrides,
      },
    ],
  }));
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
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (String(url).endsWith("/admin/health")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: "0.3.0" }),
        };
      }

      if (String(url).endsWith("/admin/register") && options.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, version: "0.3.0", registeredAt: "2026-04-27T00:00:00.000Z" }),
        };
      }

      return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    }));

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

  it("allows localhost DELETE requests without origin metadata in development", async () => {
    const { localDb, routeModule } = await loadModulesWithTempDataDir();
    const { DELETE } = routeModule;

    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (String(url).endsWith("/admin/unregister") && options.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, machineId: "machine-1" }),
        };
      }

      return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    }));

    await seedCloudUrl(localDb);

    const response = await DELETE(
      new Request("http://localhost:20128/api/cloud-urls", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: "worker-1" }),
      })
    );

    expect(response.ok).toBe(true);
    expect(response.body.remoteUnregistered).toBe(true);
    const settings = await localDb.getSettings();
    expect(settings.cloudUrls).toEqual([]);
  });

  it("keeps deleting local config when remote worker record is already missing", async () => {
    const { localDb, routeModule } = await loadModulesWithTempDataDir();
    const { DELETE } = routeModule;

    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (String(url).endsWith("/admin/unregister") && options.method === "POST") {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "Machine not registered" }),
        };
      }

      return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    }));

    await seedCloudUrl(localDb);

    const response = await DELETE(
      new Request("http://localhost:20128/api/cloud-urls", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "worker-1" }),
      })
    );

    expect(response.ok).toBe(true);
    expect(response.body.remoteUnregistered).toBe(false);
    expect((await localDb.getSettings()).cloudUrls).toEqual([]);
  });

  it("blocks local deletion when worker rejects the secret during unregister", async () => {
    const { localDb, routeModule } = await loadModulesWithTempDataDir();
    const { DELETE } = routeModule;

    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (String(url).endsWith("/admin/unregister") && options.method === "POST") {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: "Unauthorized" }),
        };
      }

      return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    }));

    await seedCloudUrl(localDb);

    const response = await DELETE(
      new Request("http://localhost:20128/api/cloud-urls", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "worker-1" }),
      })
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("Remote record was not removed");
    expect((await localDb.getSettings()).cloudUrls).toHaveLength(1);
  });

  it("accepts delete when browser origin is same-origin but the internal request URL uses a different loopback host", async () => {
    const { localDb, routeModule } = await loadModulesWithTempDataDir();
    const { DELETE } = routeModule;

    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (String(url).endsWith("/admin/unregister") && options.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, machineId: "machine-1" }),
        };
      }

      return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    }));

    await seedCloudUrl(localDb);

    const response = await DELETE(
      new Request("http://127.0.0.1:20128/api/cloud-urls", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:20128",
          referer: "http://localhost:20128/dashboard/endpoint?tab=cloud",
          "sec-fetch-site": "same-origin",
          "x-requested-with": "XMLHttpRequest",
        },
        body: JSON.stringify({ id: "worker-1" }),
      })
    );

    expect(response.ok).toBe(true);
    expect(response.body.remoteUnregistered).toBe(true);
    expect((await localDb.getSettings()).cloudUrls).toEqual([]);
  });

  it("accepts delete when forwarded localhost origin differs from the internal request host", async () => {
    const { localDb, routeModule } = await loadModulesWithTempDataDir();
    const { DELETE } = routeModule;

    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (String(url).endsWith("/admin/unregister") && options.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, machineId: "machine-1" }),
        };
      }

      return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    }));

    await seedCloudUrl(localDb);

    const response = await DELETE(
      new Request("http://0.0.0.0:20128/api/cloud-urls", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          host: "0.0.0.0:20128",
          origin: "http://localhost:20128",
          referer: "http://localhost:20128/dashboard/endpoint?tab=cloud",
          "x-forwarded-host": "localhost:20128",
          "x-forwarded-proto": "http",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ id: "worker-1" }),
      })
    );

    expect(response.ok).toBe(true);
    expect(response.body.remoteUnregistered).toBe(true);
    expect((await localDb.getSettings()).cloudUrls).toEqual([]);
  });
});
