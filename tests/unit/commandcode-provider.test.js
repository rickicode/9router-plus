import { describe, it, expect } from "vitest";

import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { parseCommandCodeSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

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

    expect(requiredTranslated.params.tool_choice).toEqual({ type: "any" });
    expect(noneTranslated.params.tool_choice).toEqual({ type: "auto" });
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

    expect(translated.params.messages).toEqual([
      { role: "user", content: "Call ping" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_123",
            name: "ping",
            input: {},
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
      { role: "user", content: "Now answer plainly" },
    ]);
  });

  it("collapses commandcode tool follow-up into a plain user message", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      messages: [
        { role: "developer", content: "ignored dev context" },
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

    expect(translated.params.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "The required tool call has already completed successfully.",
              "Tool used: bash.",
              "Use the tool result internally to finish the task.",
              "Do not repeat or quote the tool output unless the original request explicitly asks for it.",
              "Original request: Use bash then answer. After the tool returns, respond with FINAL_OK.",
              "Tool result is available: OK",
              "Do not call any tools again.",
              "Respond now with the final answer only.",
            ].join("\n\n"),
          },
        ],
      },
    ]);
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

    expect(translated.params.messages[0].content[0].text).toContain(
      "Respond with exactly FINAL_OK and nothing else.",
    );
  });
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
