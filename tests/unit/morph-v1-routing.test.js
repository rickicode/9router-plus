import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMorphV1Capability = vi.fn();
const handleChat = vi.fn();
const handleEmbeddings = vi.fn();
const initTranslators = vi.fn();
const getSettings = vi.fn();
const dispatchMorphCapability = vi.fn();

vi.mock("@/app/api/morph/v1Routing.js", () => ({
  routeMorphV1Capability,
}));

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat,
}));

vi.mock("@/sse/handlers/embeddings.js", () => ({
  handleEmbeddings,
}));

vi.mock("open-sse/translator/index.js", () => ({
  initTranslators,
}));

vi.mock("@/shared/utils/cloud.js", () => ({
  callCloudWithMachineId: vi.fn(),
}));

vi.mock("@/lib/localDb.js", () => ({
  getSettings,
}));

vi.mock("@/app/api/morph/_dispatch.js", () => ({
  dispatchMorphCapability,
}));

describe("Morph v1 route bridging", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    routeMorphV1Capability.mockResolvedValue(null);
    handleChat.mockResolvedValue(new Response(JSON.stringify({ source: "chat" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    handleEmbeddings.mockResolvedValue(new Response(JSON.stringify({ source: "embeddings" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    getSettings.mockResolvedValue({
      morph: {
        baseUrl: "https://api.morphllm.com",
        apiKeys: [{ email: "morph@example.com", key: "mk-1", status: "active", isExhausted: false }],
        roundRobinEnabled: false,
      },
    });
    dispatchMorphCapability.mockResolvedValue(new Response(JSON.stringify({ source: "morph-direct" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  });

  it("routes morph chat-completions models through Morph apply transport", async () => {
    const morphResponse = new Response(JSON.stringify({ source: "morph-apply" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
    routeMorphV1Capability.mockResolvedValueOnce(morphResponse);

    const { POST } = await import("../../src/app/api/v1/chat/completions/route.js");
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "morph-v3-large", messages: [{ role: "user", content: "hi" }] }),
    });

    const response = await POST(request);

    expect(routeMorphV1Capability).toHaveBeenCalledWith(request, "apply");
    expect(handleChat).not.toHaveBeenCalled();
    expect(initTranslators).not.toHaveBeenCalled();
    expect(response).toBe(morphResponse);
  });

  it("keeps generic chat-completions traffic on the standard handler", async () => {
    const { POST } = await import("../../src/app/api/v1/chat/completions/route.js");
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    const response = await POST(request);

    expect(routeMorphV1Capability).toHaveBeenCalledWith(request, "apply");
    expect(initTranslators).toHaveBeenCalledTimes(1);
    expect(handleChat).toHaveBeenCalledWith(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ source: "chat" });
  });

  it("routes morph embedding models through Morph embeddings transport", async () => {
    const morphResponse = new Response(JSON.stringify({ source: "morph-embeddings" }), {
      status: 206,
      headers: { "Content-Type": "application/json" },
    });
    routeMorphV1Capability.mockResolvedValueOnce(morphResponse);

    const { POST } = await import("../../src/app/api/v1/embeddings/route.js");
    const request = new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "morph-embed-fast", input: "hello" }),
    });

    const response = await POST(request);

    expect(routeMorphV1Capability).toHaveBeenCalledWith(request, "embeddings");
    expect(handleEmbeddings).not.toHaveBeenCalled();
    expect(response).toBe(morphResponse);
  });

  it("keeps /v1/messages on the standard handler", async () => {
    const { POST } = await import("../../src/app/api/v1/messages/route.js");
    const request = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "morph-v3-large", messages: [{ role: "user", content: "hi" }] }),
    });

    const response = await POST(request);

    expect(routeMorphV1Capability).not.toHaveBeenCalled();
    expect(initTranslators).toHaveBeenCalledTimes(1);
    expect(handleChat).toHaveBeenCalledWith(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ source: "chat" });
  });

  it("keeps /v1/responses on the standard handler", async () => {
    const { POST } = await import("../../src/app/api/v1/responses/route.js");
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "morph-v3-large", input: [{ role: "user", content: "hi" }] }),
    });

    const response = await POST(request);

    expect(routeMorphV1Capability).not.toHaveBeenCalled();
    expect(initTranslators).toHaveBeenCalledTimes(1);
    expect(handleChat).toHaveBeenCalledWith(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ source: "chat" });
  });

  it("keeps /v1/responses/compact on the standard handler", async () => {
    const { POST } = await import("../../src/app/api/v1/responses/compact/route.js");
    const request = new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "morph-v3-large", messages: [{ role: "user", content: "hi" }] }),
    });

    const response = await POST(request);

    expect(routeMorphV1Capability).not.toHaveBeenCalled();
    expect(handleChat).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ source: "chat" });
  });

  it("keeps generic embeddings traffic on the standard handler", async () => {
    const { POST } = await import("../../src/app/api/v1/embeddings/route.js");
    const request = new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    });

    const response = await POST(request);

    expect(routeMorphV1Capability).toHaveBeenCalledWith(request, "embeddings");
    expect(handleEmbeddings).toHaveBeenCalledWith(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ source: "embeddings" });
  });

  it("serves explicit Morph chat-completions without generic `/v1` probing", async () => {
    const { POST } = await import("../../src/app/api/morph/v1/chat/completions/route.js");
    const request = new Request("http://localhost/api/morph/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "morph-v3-large", messages: [{ role: "user", content: "hi" }] }),
    });

    const response = await POST(request);

    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(routeMorphV1Capability).not.toHaveBeenCalled();
    expect(dispatchMorphCapability).toHaveBeenCalledWith({
      capability: "apply",
      req: request,
      morphSettings: expect.objectContaining({
        baseUrl: "https://api.morphllm.com",
      }),
      upstreamTarget: { method: "POST", path: "/v1/chat/completions" },
      requestLabel: "morph:/v1/chat/completions",
    });
    await expect(response.json()).resolves.toEqual({ source: "morph-direct" });
  });

  it("serves explicit Morph embeddings without generic `/v1` probing", async () => {
    const { POST } = await import("../../src/app/api/morph/v1/embeddings/route.js");
    const request = new Request("http://localhost/api/morph/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "morph-embed-fast", input: "hello" }),
    });

    const response = await POST(request);

    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(routeMorphV1Capability).not.toHaveBeenCalled();
    expect(dispatchMorphCapability).toHaveBeenCalledWith({
      capability: "embeddings",
      req: request,
      morphSettings: expect.objectContaining({
        baseUrl: "https://api.morphllm.com",
      }),
      upstreamTarget: { method: "POST", path: "/v1/embeddings" },
      requestLabel: "morph:/v1/embeddings",
    });
    await expect(response.json()).resolves.toEqual({ source: "morph-direct" });
  });

  it("serves explicit Morph compact without generic `/v1` probing", async () => {
    const { POST } = await import("../../src/app/api/morph/v1/compact/route.js");
    const request = new Request("http://localhost/api/morph/v1/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "trim history" }),
    });

    const response = await POST(request);

    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(routeMorphV1Capability).not.toHaveBeenCalled();
    expect(dispatchMorphCapability).toHaveBeenCalledWith({
      capability: "compact",
      req: request,
      morphSettings: expect.objectContaining({
        baseUrl: "https://api.morphllm.com",
      }),
      upstreamTarget: { method: "POST", path: "/v1/compact" },
      requestLabel: "morph:/v1/compact",
    });
    await expect(response.json()).resolves.toEqual({ source: "morph-direct" });
  });

  it("serves explicit Morph rerank without generic `/v1` probing", async () => {
    const { POST } = await import("../../src/app/api/morph/v1/rerank/route.js");
    const request = new Request("http://localhost/api/morph/v1/rerank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "hello", documents: ["a", "b"] }),
    });

    const response = await POST(request);

    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(routeMorphV1Capability).not.toHaveBeenCalled();
    expect(dispatchMorphCapability).toHaveBeenCalledWith({
      capability: "rerank",
      req: request,
      morphSettings: expect.objectContaining({
        baseUrl: "https://api.morphllm.com",
      }),
      upstreamTarget: { method: "POST", path: "/v1/rerank" },
      requestLabel: "morph:/v1/rerank",
    });
    await expect(response.json()).resolves.toEqual({ source: "morph-direct" });
  });

  it("serves explicit Morph models for MCP discovery", async () => {
    const { GET } = await import("../../src/app/api/morph/v1/models/route.js");

    const response = await GET();
    const payload = await response.json();

    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(payload.object).toBe("list");
    expect(payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "morph-v3-large", object: "model", owned_by: "morph", root: "morph-v3-large" }),
        expect.objectContaining({ id: "morph-v3-fast", object: "model", owned_by: "morph", root: "morph-v3-fast" }),
        expect.objectContaining({ id: "morph-embedding-v4", object: "model", owned_by: "morph", root: "morph-embedding-v4" }),
      ])
    );
  });

  it("returns 503 for explicit Morph models when Morph is not configured", async () => {
    getSettings.mockResolvedValueOnce({ morph: { baseUrl: "", apiKeys: [], roundRobinEnabled: false } });

    const { GET } = await import("../../src/app/api/morph/v1/models/route.js");
    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Morph is not configured" });
  });
});
