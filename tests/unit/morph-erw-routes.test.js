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
const embeddingsRoutePath = path.join(repoRoot, "src/app/api/morph/embeddings/route.js");
const rerankRoutePath = path.join(repoRoot, "src/app/api/morph/rerank/route.js");
const warpgrepRoutePath = path.join(repoRoot, "src/app/api/morph/warpgrep/route.js");

async function readRouteSource(routePath) {
  return fs.readFile(routePath, "utf8");
}

describe("Morph embeddings/rerank/warpgrep routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("all three routes import dispatchMorphCapability and the shared Morph config helper", async () => {
    const [embeddingsSource, rerankSource, warpgrepSource] = await Promise.all([
      readRouteSource(embeddingsRoutePath),
      readRouteSource(rerankRoutePath),
      readRouteSource(warpgrepRoutePath),
    ]);

    for (const source of [embeddingsSource, rerankSource, warpgrepSource]) {
      expect(source).toContain('import { dispatchMorphCapability } from "@/app/api/morph/_dispatch.js";');
      expect(source).toContain('import { getConfiguredMorphSettings } from "@/app/api/morph/_shared.js";');
      expect(source).not.toContain('import { getSettings } from "@/lib/localDb.js";');
    }
  });

  it("keeps all three routes isolated from /api/v1 handlers", async () => {
    const [embeddingsSource, rerankSource, warpgrepSource] = await Promise.all([
      readRouteSource(embeddingsRoutePath),
      readRouteSource(rerankRoutePath),
      readRouteSource(warpgrepRoutePath),
    ]);

    for (const source of [embeddingsSource, rerankSource, warpgrepSource]) {
      expect(source).not.toMatch(/src\/app\/api\/v1\//);
      expect(source).not.toMatch(/@\/app\/api\/v1\//);
      expect(source).not.toMatch(/\.\.\/.*\/api\/v1\//);
    }
  });

  it("uses the correct Morph capability for each route", async () => {
    const [embeddingsSource, rerankSource, warpgrepSource] = await Promise.all([
      readRouteSource(embeddingsRoutePath),
      readRouteSource(rerankRoutePath),
      readRouteSource(warpgrepRoutePath),
    ]);

    expect(embeddingsSource).toContain('capability: "embeddings"');
    expect(rerankSource).toContain('capability: "rerank"');
    expect(warpgrepSource).toContain('capability: "warpgrep"');
  });

  it("keeps the warpgrep route as a raw pass-through without tool-call adaptation", async () => {
    const warpgrepSource = await readRouteSource(warpgrepRoutePath);

    expect(warpgrepSource).not.toMatch(/tool/i);
    expect(warpgrepSource).not.toMatch(/adapt/i);
    expect(warpgrepSource).not.toMatch(/rewrite/i);
  });

  it("returns 503 when Morph apiKeys are empty", async () => {
    getSettings.mockResolvedValue({
      morph: {
        baseUrl: "https://api.morphllm.com",
        apiKeys: [],
        roundRobinEnabled: false,
      },
    });

    const { POST } = await import("../../src/app/api/morph/embeddings/route.js");
    const response = await POST(new Request("http://localhost/api/morph/embeddings", { method: "POST" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Morph is not configured" });
    expect(dispatchMorphCapability).not.toHaveBeenCalled();
  });

  it("dispatches configured requests and returns the upstream response", async () => {
    const morphSettings = {
      baseUrl: "https://proxy.example.com",
      apiKeys: [{ email: "warpgrep@example.com", key: "mk-1", status: "active", isExhausted: false }],
      roundRobinEnabled: true,
    };
    const upstreamResponse = new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { "Content-Type": "application/json", "X-Morph": "yes" },
    });

    getSettings.mockResolvedValue({ morph: morphSettings });
    dispatchMorphCapability.mockResolvedValue(upstreamResponse);

    const { POST } = await import("../../src/app/api/morph/warpgrep/route.js");
    const request = new Request("http://localhost/api/morph/warpgrep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await POST(request);

    expect(dispatchMorphCapability).toHaveBeenCalledTimes(1);
    expect(dispatchMorphCapability).toHaveBeenCalledWith({
      capability: "warpgrep",
      req: request,
      morphSettings,
    });
    expect(response).toBe(upstreamResponse);
    expect(response.status).toBe(202);
    expect(response.headers.get("X-Morph")).toBe("yes");
  });
});
