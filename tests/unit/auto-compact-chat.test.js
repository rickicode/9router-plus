import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchMorphCapabilityMock, saveMorphUsageMock } = vi.hoisted(() => ({
  dispatchMorphCapabilityMock: vi.fn(),
  saveMorphUsageMock: vi.fn(),
}));

vi.mock("../../src/app/api/morph/_dispatch.js", () => ({
  dispatchMorphCapability: dispatchMorphCapabilityMock,
}));

vi.mock("../../src/lib/morphUsageDb.js", () => ({
  saveMorphUsage: saveMorphUsageMock,
}));

import { maybeAutoCompactChatBody } from "../../src/lib/chat/autoCompact.js";

describe("maybeAutoCompactChatBody", () => {
  beforeEach(() => {
    dispatchMorphCapabilityMock.mockReset();
    saveMorphUsageMock.mockReset();
  });

  it("runs auto compact for unknown Morph keys and logs start/completion", async () => {
    dispatchMorphCapabilityMock.mockResolvedValue(new Response(JSON.stringify({
      messages: [
        { role: "user", content: "short summary" },
        { role: "assistant", content: "assistant kept" },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const info = vi.fn();
    const warn = vi.fn();
    const body = {
      messages: [
        { role: "user", content: [{ type: "input_text", text: "Long question" }] },
        { role: "assistant", content: "assistant kept" },
      ],
      tools: [{ type: "function", function: { name: "lookup" } }],
    };

    const result = await maybeAutoCompactChatBody({
      body,
      settings: {
        autoCompact: { enabled: true, minMessages: 2, compressionRatio: 0.5 },
        morph: {
          baseUrl: "https://api.morphllm.com",
          apiKeys: [{ email: "owner@example.com", key: "TEST", status: "unknown", isExhausted: false }],
        },
      },
      request: new Request("http://localhost/v1/chat/completions", { method: "POST" }),
      log: { info, warn },
    });

    expect(dispatchMorphCapabilityMock).toHaveBeenCalledTimes(1);
    expect(saveMorphUsageMock).toHaveBeenCalledWith(expect.objectContaining({
      capability: "auto-compact",
      category: "auto_compact",
      autoCompactStats: expect.objectContaining({
        applied: true,
        savedTokensEstimate: expect.any(Number),
        reductionPercent: expect.any(Number),
      }),
    }));
    expect(result.messages[0].content).toEqual([{ type: "input_text", text: "short summary" }]);
    expect(info).toHaveBeenNthCalledWith(1, "COMPACT", "Auto compact starting for 2 messages", {
      messages: 2,
      tools: 1,
      inputFormat: false,
    });
    expect(info).toHaveBeenNthCalledWith(2, "COMPACT", "Auto compact completed for 2 messages", {
      messages: 2,
      tools: 1,
      inputFormat: false,
      compressionRatio: 0.5,
      savedTokensEstimate: expect.any(Number),
      reductionPercent: expect.any(Number),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the original body when no Morph keys are usable", async () => {
    const warn = vi.fn();
    const body = {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    };

    const result = await maybeAutoCompactChatBody({
      body,
      settings: {
        autoCompact: { enabled: true, minMessages: 2, compressionRatio: 0.5 },
        morph: {
          baseUrl: "https://api.morphllm.com",
          apiKeys: [{ email: "owner@example.com", key: "TEST", status: "inactive", isExhausted: false }],
        },
      },
      request: new Request("http://localhost/v1/chat/completions", { method: "POST" }),
      log: { info: vi.fn(), warn },
    });

    expect(result).toBe(body);
    expect(dispatchMorphCapabilityMock).toHaveBeenCalledTimes(1);
    expect(saveMorphUsageMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("COMPACT", expect.stringContaining("Auto compact skipped:"));
  });
});
