import { beforeEach, describe, expect, it, vi } from "vitest";

const getSettings = vi.fn();
const dispatchMorphCapability = vi.fn();

vi.mock("@/lib/localDb.js", () => ({
  getSettings,
}));

vi.mock("@/app/api/morph/_dispatch.js", () => ({
  dispatchMorphCapability,
}));

describe("Morph v1 routing helper", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("detects Morph model prefixes", async () => {
    const { isMorphModelValue } = await import("../../src/app/api/morph/v1Routing.js");

    expect(isMorphModelValue("morph-v3-large")).toBe(true);
    expect(isMorphModelValue("morph-embed-fast")).toBe(true);
    expect(isMorphModelValue("morph/anything")).toBe(false);
    expect(isMorphModelValue("openai/gpt-4o")).toBe(false);
    expect(isMorphModelValue(null)).toBe(false);
  });

  it("ignores non-Morph `/v1` requests", async () => {
    const { routeMorphV1Capability } = await import("../../src/app/api/morph/v1Routing.js");
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [] }),
    });

    const response = await routeMorphV1Capability(request, "apply");

    expect(response).toBeNull();
    expect(getSettings).not.toHaveBeenCalled();
    expect(dispatchMorphCapability).not.toHaveBeenCalled();
  });

  it("falls back cleanly when the `/v1` body is invalid JSON", async () => {
    const { routeMorphV1Capability } = await import("../../src/app/api/morph/v1Routing.js");
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });

    const response = await routeMorphV1Capability(request, "apply");

    expect(response).toBeNull();
    expect(getSettings).not.toHaveBeenCalled();
    expect(dispatchMorphCapability).not.toHaveBeenCalled();
  });

  it("returns 503 when Morph routing is matched but not configured", async () => {
    getSettings.mockResolvedValue({
      morph: {
        baseUrl: "https://api.morphllm.com",
        apiKeys: [],
        roundRobinEnabled: false,
      },
    });

    const { routeMorphV1Capability } = await import("../../src/app/api/morph/v1Routing.js");
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "morph-v3-large", messages: [] }),
    });

    const response = await routeMorphV1Capability(request, "apply");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Morph is not configured" });
    expect(dispatchMorphCapability).not.toHaveBeenCalled();
  });

  it("dispatches matched `/v1` traffic through the Morph capability proxy", async () => {
    const morphSettings = {
      baseUrl: "https://api.morphllm.com",
      apiKeys: [{ email: "embed@example.com", key: "mk-1", status: "active", isExhausted: false }],
      roundRobinEnabled: true,
    };
    const upstreamResponse = new Response(JSON.stringify({ ok: true }), {
      status: 207,
      headers: { "Content-Type": "application/json" },
    });
    getSettings.mockResolvedValue({ morph: morphSettings });
    dispatchMorphCapability.mockResolvedValue(upstreamResponse);

    const { routeMorphV1Capability } = await import("../../src/app/api/morph/v1Routing.js");
    const body = JSON.stringify({ model: "morph-embed-fast", input: "hello" });
    const request = new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const response = await routeMorphV1Capability(request, "embeddings");

    expect(dispatchMorphCapability).toHaveBeenCalledWith({
      capability: "embeddings",
      req: request,
      morphSettings,
      requestBody: body,
      requestPayload: { model: "morph-embed-fast", input: "hello" },
    });
    expect(response).toBe(upstreamResponse);
  });
});
