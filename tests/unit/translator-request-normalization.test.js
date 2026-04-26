import { describe, it, expect, vi } from "vitest";

vi.mock("stream", async () => await import("node:stream"));
vi.mock("/workspaces/9router/.claude/worktrees/canonical-status-phase1/stream", async () => await import("node:stream"));

import { FORMATS } from "../../open-sse/translator/formats.js";
import { detectFormatByEndpoint } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { filterToOpenAIFormat } from "../../open-sse/translator/helpers/openaiHelper.js";
import { parseSSELine } from "../../open-sse/utils/streamHelpers.js";
import { openaiResponsesToOpenAIRequest, openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { convertResponsesApiFormat } from "../../open-sse/translator/helpers/responsesApiHelper.js";

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

  it("responses -> openai maps input_image to image_url", () => {
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "describe" },
            { type: "input_image", image_url: "https://example.com/cat.png", detail: "high" },
          ],
        },
      ],
    };

    const result = openaiResponsesToOpenAIRequest("cx/gpt-5.3-codex", body, true);
    expect(Array.isArray(result.messages[0].content)).toBe(true);
    expect(result.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/cat.png", detail: "high" },
    });
  });

  it("responses helper maps input_file image payload to image_url data URI", () => {
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_file",
              file_data: "ZmFrZQ==",
              mime_type: "image/png",
              filename: "shot.png",
            },
          ],
        },
      ],
    };

    const result = convertResponsesApiFormat(body);
    expect(result.messages[0].content).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,ZmFrZQ==", detail: "auto" },
      },
    ]);
  });

  it("responses helper normalizes nested clipboard-style input_image payloads", () => {
    const body = {
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: {
                file_data: "data:image/png;base64,ZmFrZQ==",
                quality: "high",
              },
            },
          ],
        },
      ],
    };

    const result = convertResponsesApiFormat(body);
    expect(result.messages[0].content).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,ZmFrZQ==", detail: "high" },
      },
    ]);
  });

  it("responses helper normalizes nested input_file image payloads", () => {
    const body = {
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              file: {
                data: "ZmFrZQ==",
                mimeType: "image/png",
                name: "clipboard.png",
              },
            },
          ],
        },
      ],
    };

    const result = convertResponsesApiFormat(body);
    expect(result.messages[0].content).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,ZmFrZQ==", detail: "auto" },
      },
    ]);
  });

  it("openai -> responses maps file blocks to input_file", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              file: {
                file_data: "ZmFrZQ==",
                filename: "screen.png",
                mime_type: "image/png",
              },
            },
          ],
        },
      ],
    };

    const result = openaiToOpenAIResponsesRequest("cx/gpt-5.3-codex", body, true);
    expect(result.input[0].content[0]).toEqual({
      type: "input_file",
      file_data: "ZmFrZQ==",
      filename: "screen.png",
      mime_type: "image/png",
    });
  });

  it("openai -> responses maps string image_url blocks to input_image", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: "data:image/png;base64,ZmFrZQ==",
            },
          ],
        },
      ],
    };

    const result = openaiToOpenAIResponsesRequest("cx/gpt-5.3-codex", body, true);
    expect(result.input[0].content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,ZmFrZQ==",
      detail: "auto",
    });
  });

  it("detectFormatByEndpoint treats chat completions input[] as openai-responses", () => {
    const format = detectFormatByEndpoint("/api/v1/chat/completions", {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "describe this" },
            { type: "input_image", image_url: "data:image/png;base64,ZmFrZQ==" },
          ],
        },
      ],
    });

    expect(format).toBe(FORMATS.OPENAI_RESPONSES);
  });

  it("translateRequest normalizes openai-responses requests even when target stays openai-responses", async () => {
    const body = {
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              file: {
                data: "ZmFrZQ==",
                mimeType: "image/png",
                name: "clipboard.png",
              },
            },
          ],
        },
      ],
    };

    const result = await translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "cx/gpt-5.3-codex",
      JSON.parse(JSON.stringify(body)),
      true,
    );

    expect(result.input[0].content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,ZmFrZQ==",
      detail: "auto",
    });
  });
});
