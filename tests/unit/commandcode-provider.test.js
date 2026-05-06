import { describe, it, expect, vi } from "vitest";

import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { parseCommandCodeSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

vi.mock("../../open-sse/config/commandcodeInstructionsResolver.js", () => ({
  resolveCommandCodeInstructionsForRequest: vi.fn(async () => "DEFAULT_COMMANDCODE_INSTRUCTIONS"),
}));

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
    expect(translated.params.tools).toEqual([
      {
        name: "ping",
        description: "Ping tool",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
    ]);
    expect(translated.params.toolChoice).toEqual({ type: "tool", name: "ping" });
    expect(translated.config.workingDir).toBe(process.cwd());
  });

  it("normalizes Command Code tool_choice control values to objects", async () => {
    const requiredBody = {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Use a tool" }],
      tools: [{
        type: "function",
        function: {
          name: "ping",
          description: "Ping tool",
          parameters: { type: "object", properties: {} },
        },
      }],
      tool_choice: "required",
    };

    const noneBody = {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Do not use a tool" }],
      tool_choice: "none",
    };

    const requiredTranslated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-flash",
      structuredClone(requiredBody),
      false,
      null,
      "commandcode",
    );
    const noneTranslated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-flash",
      structuredClone(noneBody),
      false,
      null,
      "commandcode",
    );

    expect(requiredTranslated.params.toolChoice).toEqual({ type: "any" });
    expect(noneTranslated.params.toolChoice).toEqual({ type: "none" });
  });

  it("injects default instructions even when request contains tool history but no explicit system/developer messages", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "user", content: "Call ping" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "ping", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_123",
          content: "OK",
        },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.system).toContain("DEFAULT_COMMANDCODE_INSTRUCTIONS");
  });

  it("preserves tool result ids from alternate tool message fields", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "user", content: "Call ping" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "ping", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_123",
          content: "OK",
        },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.system).toContain("DEFAULT_COMMANDCODE_INSTRUCTIONS");
    expect(translated.params.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Call ping",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "ping",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123",
            toolName: "ping",
            output: {
              type: "text",
              value: "OK",
            },
          },
        ],
      },
    ]);
  });

  it("preserves object-shaped tool result content in commandcode follow-up", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "user", content: "Call ping" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "ping", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_123",
          content: { status: "ok", value: 42 },
        },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.messages[2].content[0]).toEqual({
      type: "tool-result",
      toolCallId: "call_123",
      toolName: "ping",
      output: {
        type: "json",
        value: JSON.stringify({ status: "ok", value: 42 }),
      },
    });
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

  it("reconstructs repeated snapshot tool-call deltas without duplicating arguments", async () => {
    const raw = [
      '{"type":"start","id":"msg_snap_123","model":"deepseek/deepseek-v4-pro"}',
      '{"type":"finish-step","finishReason":"tool-calls","response":{"content":[{"type":"tool_use","id":"call_snap","name":"ping","input":{}}]}}',
      '{"type":"finish","finishReason":"tool-calls","response":{"content":[{"type":"tool_use","id":"call_snap","name":"ping","input":{}}]}}',
    ].join("\n");

    const parsed = await parseCommandCodeSSEToOpenAIResponse(raw, "deepseek/deepseek-v4-pro");

    expect(parsed.choices[0].message.tool_calls).toEqual([
      {
        id: "call_snap",
        type: "function",
        function: {
          name: "ping",
          arguments: "{}",
        },
      },
    ]);
  });

  it("preserves prose when text contains pseudo tool-call markup alongside normal text", async () => {
    const raw = [
      '{"type":"start","id":"msg_mix_123","model":"deepseek/deepseek-v4-pro"}',
      '{"type":"text-start"}',
      '{"type":"text-delta","text":"I will now call a tool. <tool_call name=\\"ping\\"><parameter name=\\"x\\">1</parameter></tool_call>"}',
      '{"type":"text-end"}',
      '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":10,"outputTokens":5,"totalTokens":15}}',
    ];

    const parsed = await parseCommandCodeSSEToOpenAIResponse(raw, "deepseek/deepseek-v4-pro");

    expect(parsed.choices[0].message.content).toContain("I will now call a tool.");
    expect(parsed.choices[0].message.tool_calls).toEqual([
      {
        id: expect.stringMatching(/^call_/),
        type: "function",
        function: {
          name: "ping",
          arguments: JSON.stringify({ x: 1 }),
        },
      },
    ]);
  });

  it("converts pseudo tool-call text markup into OpenAI tool calls", async () => {
    const raw = [
      '{"type":"start","id":"msg_123","model":"deepseek/deepseek-v4-pro"}',
      '{"type":"text-start"}',
      '{"type":"text-delta","text":"<tool_calls>\\n<tool_call name=\\"explore\\">\\n<parameter name=\\"messages\\">[{\\"content\\":\\"Audit the repo\\"}]</parameter>\\n</tool_call>\\n</tool_calls>"}',
      '{"type":"text-end"}',
      '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":10,"outputTokens":5,"totalTokens":15}}',
    ];

    const parsed = await parseCommandCodeSSEToOpenAIResponse(raw, "deepseek/deepseek-v4-pro");

    expect(parsed.choices[0].finish_reason).toBe("tool_calls");
    expect(parsed.choices[0].message.content).toBeNull();
    expect(parsed.choices[0].message.tool_calls).toEqual([
      {
        id: expect.stringMatching(/^call_/),
        type: "function",
        function: {
          name: "explore",
          arguments: JSON.stringify({ messages: [{ content: "Audit the repo" }] }),
        },
      },
    ]);
  });

  it("recovers final assistant text from finish-step response blocks", async () => {
    const state = { ...initState(FORMATS.OPENAI), model: "deepseek/deepseek-v4-pro" };
    const events = [
      { type: "start", id: "msg_123", model: "deepseek/deepseek-v4-pro" },
      {
        type: "finish-step",
        finishReason: "stop",
        usage: { raw: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
        response: {
          content: [
            { type: "text", text: "FINAL_OK" },
          ],
        },
      },
      { type: "finish", finishReason: "stop" },
    ];

    const chunks = [];
    for (const event of events) {
      const translated = await translateResponse(FORMATS.COMMANDCODE, FORMATS.OPENAI, event, state);
      if (translated?.length) chunks.push(...translated);
    }

    const textDeltas = chunks.flatMap((chunk) => chunk.choices?.map((choice) => choice.delta?.content).filter(Boolean) || []);
    expect(textDeltas.join("")).toContain("FINAL_OK");
  });

  it("parses final assistant text from finish-step blocks in non-stream fallback", async () => {
    const raw = [
      '{"type":"start","id":"msg_123","model":"deepseek/deepseek-v4-pro"}',
      '{"type":"finish-step","finishReason":"stop","usage":{"raw":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}},"response":{"content":[{"type":"text","text":"FINAL_OK"}]}}',
      '{"type":"finish","finishReason":"stop"}',
    ].join("\n");

    const parsed = await parseCommandCodeSSEToOpenAIResponse(raw, "deepseek/deepseek-v4-pro");

    expect(parsed.choices[0].message.content).toBe("FINAL_OK");
    expect(parsed.choices[0].finish_reason).toBe("stop");
    expect(parsed.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 2,
      total_tokens: 14,
    });
  });

  it("does not duplicate final text when finish-step and finish repeat the same response block", async () => {
    const raw = [
      '{"type":"start","id":"msg_123","model":"deepseek/deepseek-v4-pro"}',
      '{"type":"finish-step","finishReason":"stop","response":{"content":[{"type":"text","text":"FINAL_OK"}]}}',
      '{"type":"finish","finishReason":"stop","response":{"content":[{"type":"text","text":"FINAL_OK"}]}}',
    ].join("\n");

    const parsed = await parseCommandCodeSSEToOpenAIResponse(raw, "deepseek/deepseek-v4-pro");

    expect(parsed.choices[0].message.content).toBe("FINAL_OK");
  });

  it("preserves repeated identical text blocks within a single response", async () => {
    const raw = [
      '{"type":"start","id":"msg_123","model":"deepseek/deepseek-v4-pro"}',
      '{"type":"finish-step","finishReason":"stop","response":{"content":[{"type":"text","text":"echo"},{"type":"text","text":"echo"}]}}',
      '{"type":"finish","finishReason":"stop"}',
    ].join("\n");

    const parsed = await parseCommandCodeSSEToOpenAIResponse(raw, "deepseek/deepseek-v4-pro");

    expect(parsed.choices[0].message.content).toBe("echoecho");
  });

  it("normalizes native Command Code text response into OpenAI chat completion shape", () => {
    const responseBody = {
      id: "msg_real_123",
      type: "message",
      role: "assistant",
      model: "",
      content: [
        { type: "text", text: "OK" },
      ],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 7531,
        output_tokens: 1,
        cache_read_input_tokens: 7424,
        cache_creation_input_tokens: 0,
      },
    };

    const translated = translateNonStreamingResponse(
      responseBody,
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
    );

    expect(translated).toEqual({
      id: "chatcmpl-msg_real_123",
      object: "chat.completion",
      created: expect.any(Number),
      model: "commandcode",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 7531,
        completion_tokens: 1,
        total_tokens: 7532,
      },
    });
  });

  it("normalizes native Command Code tool_use response into OpenAI chat completion shape", () => {
    const responseBody = {
      id: "msg_real_tool_123",
      type: "message",
      role: "assistant",
      model: "",
      content: [
        {
          type: "tool_use",
          id: "call_abc",
          name: "ping",
          input: {},
        },
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 7819,
        output_tokens: 26,
        cache_read_input_tokens: 7424,
        cache_creation_input_tokens: 0,
      },
    };

    const translated = translateNonStreamingResponse(
      responseBody,
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
    );

    expect(translated).toEqual({
      id: "chatcmpl-msg_real_tool_123",
      object: "chat.completion",
      created: expect.any(Number),
      model: "commandcode",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "ping",
                  arguments: "{}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 7819,
        completion_tokens: 26,
        total_tokens: 7845,
      },
    });
  });

  it("matches the real Command Code API text response shape", () => {
    const responseBody = {
      id: "msg_aeb94bad-d3db-48a7-8aab-d0c735dcb074",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      model: "",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 7531,
        output_tokens: 1,
        cache_read_input_tokens: 7424,
        cache_creation_input_tokens: 0,
      },
    };

    const translated = translateNonStreamingResponse(
      responseBody,
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
    );

    expect(translated.choices[0].message.content).toBe("OK");
    expect(translated.choices[0].finish_reason).toBe("stop");
    expect(translated.usage).toEqual({
      prompt_tokens: 7531,
      completion_tokens: 1,
      total_tokens: 7532,
    });
  });

  it("matches the real Command Code API tool_use response shape", () => {
    const responseBody = {
      id: "msg_ecf14dc1-9185-4e9f-a0de-a4dde0d22a77",
      type: "message",
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "call_00_aGWAj99qnU3cit4kV4Dd9505",
        name: "ping",
        input: {},
      }],
      model: "",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 7819,
        output_tokens: 26,
        cache_read_input_tokens: 7808,
        cache_creation_input_tokens: 0,
      },
    };

    const translated = translateNonStreamingResponse(
      responseBody,
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
    );

    expect(translated.choices[0].message.tool_calls).toEqual([
      {
        id: "call_00_aGWAj99qnU3cit4kV4Dd9505",
        type: "function",
        function: {
          name: "ping",
          arguments: "{}",
        },
      },
    ]);
    expect(translated.choices[0].finish_reason).toBe("tool_calls");
    expect(translated.usage).toEqual({
      prompt_tokens: 7819,
      completion_tokens: 26,
      total_tokens: 7845,
    });
  });

  it("converts Claude-compatible non-stream OpenAI-shaped responses back to native Claude messages", () => {
    const responseBody = {
      id: "chatcmpl-test123",
      object: "chat.completion",
      model: "deepseek/deepseek-v4-flash",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "ping",
                  arguments: "{}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      },
    };

    const translated = translateNonStreamingResponse(
      responseBody,
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
    );

    expect(translated).toEqual({
      id: "test123",
      type: "message",
      role: "assistant",
      model: "deepseek/deepseek-v4-flash",
      content: [
        {
          type: "tool_use",
          id: "call_123",
          name: "ping",
          input: {},
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    });
  });

  it("normalizes pi-style tool loop history into Command Code message blocks", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "user", content: "Call ping" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "ping",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_123",
          content: "OK",
        },
        { role: "user", content: "Now answer plainly" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "ping",
          description: "Ping tool",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      }],
      tool_choice: "auto",
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.system).toContain("DEFAULT_COMMANDCODE_INSTRUCTIONS");
    expect(translated.params.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Call ping" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_123", toolName: "ping", input: {} }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_123",
          toolName: "ping",
          output: { type: "text", value: "OK" },
        }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Now answer plainly" }],
      },
    ]);
  });

  it("collapses commandcode tool follow-up into a plain user message", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "developer", content: "Always modify app code, never edit DESIGN.md unless explicitly asked." },
        { role: "user", content: "Use bash then answer. After the tool returns, respond with FINAL_OK." },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "bash", arguments: "{\"command\":\"printf OK\"}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_123", content: "OK" },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.system).toContain("Always modify app code, never edit DESIGN.md unless explicitly asked.");
    expect(translated.params.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Use bash then answer. After the tool returns, respond with FINAL_OK." }],
      },
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_123",
          toolName: "bash",
          input: { command: "printf OK" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_123",
          toolName: "bash",
          output: { type: "text", value: "OK" },
        }],
      },
    ]);
  });

  it("injects default commandcode instructions when explicit instruction roles are absent", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "user", content: "Analyze the UI and make it more compact." },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.system).toContain("DEFAULT_COMMANDCODE_INSTRUCTIONS");
    expect(translated.params.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Analyze the UI and make it more compact.",
          },
        ],
      },
    ]);
  });

  it("preserves developer instructions in translated params.messages", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "system", content: "System guardrail" },
        { role: "developer", content: "Developer guardrail" },
        { role: "user", content: "Redesign the app" },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.system).toContain("System guardrail");
    expect(translated.params.system).toContain("Developer guardrail");
    expect(translated.params.system).not.toContain("DEFAULT_COMMANDCODE_INSTRUCTIONS");
    expect(translated.params.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Redesign the app",
          },
        ],
      },
    ]);
  });

  it("keeps redesign guardrails when DESIGN.md is referenced as a style source", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        {
          role: "developer",
          content: [
            "Redesign the existing web app UI, do not edit DESIGN.md unless the user explicitly asks to modify that file.",
            "Treat @DESIGN.md as a design rules reference only when the user asks to follow it.",
          ].join(" "),
        },
        {
          role: "user",
          content: "Ubah total UI/UX dan layout web agar mengikuti aturan dari @DESIGN.md sepenuhnya dark mode, tanpa light mode.",
        },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.system).toContain("Redesign the existing web app UI, do not edit DESIGN.md unless the user explicitly asks to modify that file.");
    expect(translated.params.system).toContain("Treat @DESIGN.md as a design rules reference only when the user asks to follow it.");
    expect(translated.params.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Ubah total UI/UX dan layout web agar mengikuti aturan dari @DESIGN.md sepenuhnya dark mode, tanpa light mode.",
          },
        ],
      },
    ]);
  });

  it("collapses user-format tool_result follow-up into a plain user message", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "user", content: "Use ping then answer plainly." },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "ping", arguments: "{}" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_123",
              content: "OK",
            },
          ],
        },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.system).toContain("DEFAULT_COMMANDCODE_INSTRUCTIONS");
    expect(translated.params.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Use ping then answer plainly." }],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_123", toolName: "ping", input: {} }],
      },
      {
        role: "user",
        content: [{
          type: "tool-result",
          toolCallId: "call_123",
          toolName: "tool",
          output: { type: "text", value: "OK" },
        }],
      },
    ]);
  });

  it("names multiple tools in commandcode tool follow-up", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "user", content: "Use tools then answer." },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "fetchA", arguments: "{}" },
            },
            {
              id: "call_456",
              type: "function",
              function: { name: "fetchB", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_456",
          content: "DONE",
        },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.messages[1].content).toEqual([
      { type: "tool-call", toolCallId: "call_123", toolName: "fetchA", input: {} },
      { type: "tool-call", toolCallId: "call_456", toolName: "fetchB", input: {} },
    ]);
  });

  it("preserves multiple user-format tool results in commandcode tool follow-up", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "user", content: "Use tools then answer." },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "fetchA", arguments: "{}" },
            },
            {
              id: "call_456",
              type: "function",
              function: { name: "fetchB", arguments: "{}" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_123", content: "A" },
            { type: "tool_result", tool_use_id: "call_456", content: "B" },
          ],
        },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.messages[2].content[0].output.value).toBe("A");
    expect(translated.params.messages[2].content[1].output.value).toBe("B");
  });

  it("preserves non-text tool results in commandcode tool follow-up", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "user", content: "Use screenshot tool then answer." },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "screenshot", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_123",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/result.png" },
            },
          ],
        },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.messages[2].content[0].output.type).toBe("json");
    expect(translated.params.messages[2].content[0].toolName).toBe("screenshot");
  });

  it("preserves exact final-answer instructions in commandcode tool follow-up", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "user", content: "Use bash once. After the tool returns, respond with exactly FINAL_OK and nothing else." },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "bash", arguments: "{\"command\":\"printf OK\"}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_123", content: "OK" },
      ],
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-pro",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.params.messages[0].content[0].text).toBe(
      "Use bash once. After the tool returns, respond with exactly FINAL_OK and nothing else.",
    );
  });

  it("includes real repo context in Command Code config", async () => {
    const body = {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Analyze this repository" }],
      max_tokens: 64,
    };

    const translated = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4-flash",
      structuredClone(body),
      false,
      null,
      "commandcode",
    );

    expect(translated.config.workingDir).toBe(process.cwd());
    expect(translated.config.isGitRepo).toBe(true);
    expect(translated.config.currentBranch).toBeTruthy();
    expect(translated.config.mainBranch).toBeTruthy();
    expect(Array.isArray(translated.config.recentCommits)).toBe(true);
  });
});
