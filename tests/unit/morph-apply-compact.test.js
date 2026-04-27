import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const getSettings = vi.fn();
const dispatchMorphCapability = vi.fn();

vi.mock("@/lib/localDb.js", () => ({
  getSettings,
}));

vi.mock("@/app/api/morph/_dispatch.js", () => ({
  dispatchMorphCapability,
}));

const repoRoot = path.resolve(import.meta.dirname, "../..");
const applyRoutePath = path.join(repoRoot, "src/app/api/morph/apply/route.js");
const compactRoutePath = path.join(repoRoot, "src/app/api/morph/compact/route.js");

async function readRouteSource(routePath) {
  return fs.readFile(routePath, "utf8");
}

describe("Morph apply/compact routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("apply route imports dispatchMorphCapability and getSettings", async () => {
    const source = await readRouteSource(applyRoutePath);

    expect(source).toContain('import { dispatchMorphCapability } from "@/app/api/morph/_dispatch.js";');
    expect(source).toContain('import { getSettings } from "@/lib/localDb.js";');
  });

  it("compact route imports dispatchMorphCapability and getSettings", async () => {
    const source = await readRouteSource(compactRoutePath);

    expect(source).toContain('import { dispatchMorphCapability } from "@/app/api/morph/_dispatch.js";');
    expect(source).toContain('import { getSettings } from "@/lib/localDb.js";');
  });

  it("keeps both routes isolated from /api/v1 handlers", async () => {
    const [applySource, compactSource] = await Promise.all([
      readRouteSource(applyRoutePath),
      readRouteSource(compactRoutePath),
    ]);

    for (const source of [applySource, compactSource]) {
      expect(source).not.toMatch(/src\/app\/api\/v1\//);
      expect(source).not.toMatch(/@\/app\/api\/v1\//);
      expect(source).not.toMatch(/\.\.\/.*\/api\/v1\//);
    }
  });

  it("uses the correct Morph capability for each route", async () => {
    const [applySource, compactSource] = await Promise.all([
      readRouteSource(applyRoutePath),
      readRouteSource(compactRoutePath),
    ]);

    expect(applySource).toContain('capability: "apply"');
    expect(compactSource).toContain('capability: "compact"');
  });

  it("returns 503 when Morph apiKeys are empty", async () => {
    getSettings.mockResolvedValue({
      morph: {
        baseUrl: "https://api.morphllm.com",
        apiKeys: [],
        roundRobinEnabled: false,
      },
    });

    const { POST } = await import("../../src/app/api/morph/apply/route.js");
    const response = await POST(new Request("http://localhost/api/morph/apply", { method: "POST" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Morph is not configured" });
    expect(dispatchMorphCapability).not.toHaveBeenCalled();
  });

  it("dispatches configured requests and returns the upstream response", async () => {
    const morphSettings = {
      baseUrl: "https://proxy.example.com",
      apiKeys: ["mk-1"],
      roundRobinEnabled: true,
    };
    const upstreamResponse = new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { "Content-Type": "application/json", "X-Morph": "yes" },
    });

    getSettings.mockResolvedValue({ morph: morphSettings });
    dispatchMorphCapability.mockResolvedValue(upstreamResponse);

    const { POST } = await import("../../src/app/api/morph/compact/route.js");
    const request = new Request("http://localhost/api/morph/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const response = await POST(request);

    expect(dispatchMorphCapability).toHaveBeenCalledTimes(1);
    expect(dispatchMorphCapability).toHaveBeenCalledWith({
      capability: "compact",
      req: request,
      morphSettings,
    });
    expect(response).toBe(upstreamResponse);
    expect(response.status).toBe(202);
    expect(response.headers.get("X-Morph")).toBe("yes");
  });
});
