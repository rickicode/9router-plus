import { describe, it, expect } from "vitest";

import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { parseCommandCodeSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

describe("commandcode provider", () => {
  it("normalizes OpenAI tools into Command Code request schema", async () => {
    const body = {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Use ping" }],
      max_tokens: 64,
      temperature: 0,
      tools: [{
        type: "function",
        function: {
          name: "ping",
          description: "Ping tool",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      }],
      tool_choice: { type: "function", function: { name: "ping" } },
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-flash",
      structuredClone(body),
      true,
      null,
      "commandcode",
    );

    expect(translated.model).toBe("deepseek/deepseek-v4-flash");
    expect(translated.params.provider).toBe("deepseek");
    expect(translated.params.tools).toEqual([
      {
        name: "ping",
        description: "Ping tool",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
    ]);
    expect(translated.params.tool_choice).toEqual({ type: "tool", name: "ping" });
    expect(translated.config.workingDir).toBe("/tmp");
  });

  it("preserves backend model slug for non-DeepSeek Command Code models", async () => {
    const body = {
      model: "Qwen/Qwen3.6-Plus",
      messages: [{ role: "user", content: "Reply with exactly OK" }],
      max_tokens: 4,
      temperature: 0,
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "Qwen/Qwen3.6-Plus",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.model).toBe("Qwen/Qwen3.6-Plus");
    expect(translated.params.model).toBe("Qwen/Qwen3.6-Plus");
    expect(translated.params.provider).toBe("Qwen");
  });

  it("translates Command Code JSONL tool stream into OpenAI chunks", async () => {
    const state = { ...initState(FORMATS.OPENAI), model: "deepseek/deepseek-v4-flash" };
    const events = [
      { type: "start" },
      { type: "tool-input-start", id: "call_123", toolName: "ping" },
      { type: "tool-input-delta", id: "call_123", delta: "{}" },
      { type: "tool-input-end", id: "call_123" },
      { type: "tool-call", toolCallId: "call_123", toolName: "ping", input: {} },
      {
        type: "finish-step",
        finishReason: "tool-calls",
        rawFinishReason: "tool_calls",
        usage: {
          raw: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
          },
        },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        rawFinishReason: "tool_calls",
        totalUsage: {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
        },
      },
    ];

    const chunks = [];
    for (const event of events) {
      const translated = await translateResponse(FORMATS.COMMANDCODE, FORMATS.OPENAI, event, state);
      if (translated?.length) chunks.push(...translated);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[1].choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      id: "call_123",
      type: "function",
      function: {
        name: "ping",
        arguments: "{}",
      },
    });
    expect(chunks[2].choices[0].finish_reason).toBe("tool_calls");
    expect(chunks[2].usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
    });
  });

  it("parses Command Code non-stream fallback from JSONL SSE text", async () => {
    const raw = [
      '{"type":"start","id":"msg_123","model":"deepseek/deepseek-v4-flash"}',
      '{"type":"tool-input-start","id":"call_123","toolName":"ping"}',
      '{"type":"tool-input-delta","id":"call_123","delta":"{}"}',
      '{"type":"tool-call","toolCallId":"call_123","toolName":"ping","input":{}}',
      '{"type":"finish","finishReason":"tool-calls","rawFinishReason":"tool_calls","totalUsage":{"inputTokens":12,"outputTokens":3,"totalTokens":15}}'
    ].join("\n");

    const parsed = await parseCommandCodeSSEToOpenAIResponse(raw, "deepseek/deepseek-v4-flash");

    expect(parsed.choices[0].message.tool_calls).toEqual([
      {
        id: "call_123",
        type: "function",
        function: {
          name: "ping",
          arguments: "{}",
        },
      },
    ]);
    expect(parsed.choices[0].finish_reason).toBe("tool_calls");
    expect(parsed.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
    });
  });
});
