import { afterEach, describe, expect, it } from "vitest";

describe("Kiro payload trimming", () => {
  const originalMaxPayloadBytes = process.env.KIRO_MAX_PAYLOAD_BYTES;
  const originalMaxPayloadChars = process.env.KIRO_MAX_PAYLOAD_CHARS;

  afterEach(() => {
    if (originalMaxPayloadBytes === undefined) {
      delete process.env.KIRO_MAX_PAYLOAD_BYTES;
    } else {
      process.env.KIRO_MAX_PAYLOAD_BYTES = originalMaxPayloadBytes;
    }

    if (originalMaxPayloadChars === undefined) {
      delete process.env.KIRO_MAX_PAYLOAD_CHARS;
    } else {
      process.env.KIRO_MAX_PAYLOAD_CHARS = originalMaxPayloadChars;
    }
  });

  it("drops oldest history and trims text before sending oversized payloads to Kiro", async () => {
    process.env.KIRO_MAX_PAYLOAD_BYTES = "20000";
    const { buildKiroPayload } = await import("../../open-sse/translator/request/openai-to-kiro.js");

    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}: ${"x".repeat(5000)}`,
    }));
    messages.push({ role: "user", content: `latest ${"y".repeat(12000)}` });

    const payload = buildKiroPayload("claude-sonnet-4", { messages }, true, {});
    const serializedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

    expect(serializedBytes).toBeLessThanOrEqual(20000);
    expect(payload.conversationState.history.length).toBeLessThan(30);
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("latest");
  });

  it("removes oversized optional tool context if current message still cannot fit", async () => {
    process.env.KIRO_MAX_PAYLOAD_BYTES = "20000";
    const { buildKiroPayload } = await import("../../open-sse/translator/request/openai-to-kiro.js");

    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: `run tool ${"a".repeat(30000)}` }],
      },
    ];
    const tools = [
      {
        type: "function",
        function: {
          name: "huge_tool",
          description: "d".repeat(30000),
          parameters: {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 100 }, (_, index) => [`field_${index}`, { type: "string", description: "s".repeat(1000) }])
            ),
          },
        },
      },
    ];

    const payload = buildKiroPayload("claude-sonnet-4", { messages, tools }, true, {});
    const serializedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

    expect(serializedBytes).toBeLessThanOrEqual(20000);
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain("truncated");
  });

  it("uses the legacy char env as a byte-budget fallback", async () => {
    delete process.env.KIRO_MAX_PAYLOAD_BYTES;
    process.env.KIRO_MAX_PAYLOAD_CHARS = "20000";
    const { buildKiroPayload } = await import("../../open-sse/translator/request/openai-to-kiro.js");

    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}: ${"m".repeat(5000)}`,
    }));
    messages.push({ role: "user", content: `latest ${"n".repeat(12000)}` });

    const payload = buildKiroPayload("claude-sonnet-4", { messages }, true, {});
    const serializedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

    expect(serializedBytes).toBeLessThanOrEqual(20000);
  });

  it("can still fit impossible-to-fit message bodies by dropping content completely if needed", async () => {
    process.env.KIRO_MAX_PAYLOAD_BYTES = "12000";
    const { buildKiroPayload } = await import("../../open-sse/translator/request/openai-to-kiro.js");

    const messages = [
      {
        role: "user",
        content: `latest ${"q".repeat(30000)}`,
      },
    ];
    const tools = Array.from({ length: 8 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `desc_${index}_${"d".repeat(1200)}`,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 20 }, (_, propIndex) => [`field_${propIndex}`, { type: "string", description: "x".repeat(200) }])
          ),
        },
      },
    }));

    const payload = buildKiroPayload("claude-sonnet-4", { messages, tools }, true, {});
    const serializedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

    expect(serializedBytes).toBeLessThanOrEqual(12000);
    expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools).toBeUndefined();
    expect(payload.conversationState.currentMessage.userInputMessage.content).toBe("");
  });

  it("uses the safer default byte budget when no env override is provided", async () => {
    delete process.env.KIRO_MAX_PAYLOAD_BYTES;
    delete process.env.KIRO_MAX_PAYLOAD_CHARS;
    const { buildKiroPayload } = await import("../../open-sse/translator/request/openai-to-kiro.js");

    const messages = Array.from({ length: 120 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}: ${"z".repeat(9000)}`,
    }));
    messages.push({ role: "user", content: `latest ${"k".repeat(18000)}` });

    const payload = buildKiroPayload("claude-sonnet-4", { messages }, true, {});
    const serializedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

    expect(serializedBytes).toBeLessThanOrEqual(580000);
  });
});
