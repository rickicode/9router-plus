import { beforeEach, describe, expect, it, vi } from "vitest";

const handleChatCore = vi.fn();

vi.mock("../../open-sse/handlers/chatCore.js", () => ({
  handleChatCore,
}));

vi.mock("../../open-sse/translator/helpers/responsesApiHelper.js", () => ({
  convertResponsesApiFormat: vi.fn((body) => ({ ...body })),
}));

vi.mock("../../open-sse/transformer/responsesTransformer.js", () => ({
  createResponsesApiTransformStream: vi.fn(),
}));

const { handleResponsesCore } = await import("../../open-sse/handlers/responsesHandler.js");

describe("handleResponsesCore timeout handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 504 when responses SSE-to-JSON conversion hits upstream timeout", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(Object.assign(new Error("codex upstream timed out after 45000ms"), {
          name: "AbortError",
          code: "UPSTREAM_TIMEOUT",
          timeoutMs: 45000,
        }));
      },
    });

    handleChatCore.mockResolvedValue({
      success: true,
      response: new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    });

    const result = await handleResponsesCore({
      body: {},
      modelInfo: { provider: "codex", model: "gpt-5.4" },
      credentials: {},
      connectionId: "conn-1",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    await expect(result.response.json()).resolves.toMatchObject({
      error: expect.objectContaining({
        message: "codex upstream timed out after 45000ms",
        code: "gateway_timeout",
      }),
    });
  });
});
