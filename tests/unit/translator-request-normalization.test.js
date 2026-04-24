import { describe, it, expect, vi } from "vitest";

vi.mock("stream", async () => await import("node:stream"));
vi.mock("/workspaces/9router/.claude/worktrees/canonical-status-phase1/stream", async () => await import("node:stream"));

import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { filterToOpenAIFormat } from "../../open-sse/translator/helpers/openaiHelper.js";
import { parseSSELine } from "../../open-sse/utils/streamHelpers.js";

describe("request normalization", () => {
  it("claudeToOpenAIRequest flattens text-only content arrays into string", async () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "text", text: "there" },
          ],
        },
      ],
    };

    const result = claudeToOpenAIRequest("gpt-oss:120b", body, true);
    expect(result.messages[0].content).toBe("hi\nthere");
  });

  it("claudeToOpenAIRequest preserves multimodal arrays", async () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "ZmFrZQ==",
              },
            },
          ],
        },
      ],
    };

    const result = claudeToOpenAIRequest("gpt-4o", body, true);
    expect(Array.isArray(result.messages[0].content)).toBe(true);
  });

  it("filterToOpenAIFormat flattens text-only arrays to string", async () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    };

    const result = filterToOpenAIFormat(JSON.parse(JSON.stringify(body)));
    expect(result.messages[0].content).toBe("a\nb");
  });

  it("translateRequest keeps /v1/messages Claude->OpenAI text payloads string-safe", async () => {
    const body = {
      model: "ollama/gpt-oss:120b",
      system: [{ type: "text", text: "You are helpful." }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
          ],
        },
      ],
      stream: true,
    };

    const result = await translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "gpt-oss:120b",
      JSON.parse(JSON.stringify(body)),
      true,
      null,
      "ollama",
    );

    const userMessage = result.messages.find((m) => m.role === "user");
    expect(typeof userMessage.content).toBe("string");
    expect(userMessage.content).toBe("hello\nworld");
  });

  it("translateRequest still inserts missing tool responses before normalization", async () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "lookupWeather",
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
        {
          role: "user",
          content: "Thanks",
        },
      ],
    };

    const result = await translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "gpt-4o",
      JSON.parse(JSON.stringify(body)),
      true,
    );

    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "",
    });
    expect(result.messages[2]).toEqual({
      role: "user",
      content: "Thanks",
    });
  });

  it("parseSSELine supports provider raw NDJSON stream lines", () => {
    const raw = JSON.stringify({
      model: "gpt-oss:120b",
      message: { role: "assistant", content: "hello" },
      done: false,
    });

    const parsed = parseSSELine(raw);
    expect(parsed).toEqual({
      model: "gpt-oss:120b",
      message: { role: "assistant", content: "hello" },
      done: false,
    });
  });

  it("parseSSELine still supports SSE data lines", () => {
    const parsed = parseSSELine('data: {"choices":[{"delta":{"content":"hi"}}]}');
    expect(parsed.choices[0].delta.content).toBe("hi");
  });
});
