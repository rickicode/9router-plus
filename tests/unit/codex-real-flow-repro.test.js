// Black-box reproduction: feeds an OpenCode-shaped Chat Completions body
// (clipboard image as data: URI inside image_url) all the way through
// translateRequest + CodexExecutor.execute, and asserts on the EXACT body
// that would be sent to the Codex backend.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("stream", async () => await import("node:stream"));

import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { detectFormat } from "../../open-sse/services/provider.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const DATA_URI = `data:image/png;base64,${PNG_BASE64}`;

function mockSseUpstream() {
  const sseStream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Map([["content-type", "text/event-stream"]]),
    body: sseStream,
  };
}

describe("OpenCode clipboard image end-to-end repro", () => {
  let captured;

  beforeEach(() => {
    captured = { body: null, url: null, headers: null };
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(
      async (url, init) => {
        captured.url = url;
        captured.body = init.body;
        captured.headers = init.headers;
        return mockSseUpstream();
      },
    );
  });

  it("OpenCode chat-completions image_url data URI -> Codex backend gets input_image with data: URI", async () => {
    const openCodeBody = {
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "You are a coding assistant." },
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            { type: "image_url", image_url: { url: DATA_URI } },
          ],
        },
      ],
      stream: true,
      temperature: 0.7,
    };

    expect(detectFormat(openCodeBody)).toBe("openai");

    const translated = await translateRequest(
      "openai",
      FORMATS.OPENAI_RESPONSES,
      "gpt-5.4",
      openCodeBody,
      true,
      null,
      "codex",
    );

    const executor = new CodexExecutor();
    await executor.execute({
      model: "gpt-5.4",
      body: translated,
      stream: true,
      credentials: {
        accessToken: "fake-token",
        accountId: "fake-account",
        sessionId: "fake-session",
        token: "fake-token",
        access_token: "fake-token",
      },
    });

    expect(captured.body).toBeTruthy();
    const parsed = JSON.parse(captured.body);

    // eslint-disable-next-line no-console
    console.log("\n=== OUTGOING UPSTREAM REQUEST (truncated) ===");
    const safe = JSON.parse(JSON.stringify(parsed));
    safe.input?.forEach((it) => {
      if (Array.isArray(it.content)) {
        it.content.forEach((c) => {
          if (typeof c.image_url === "string" && c.image_url.length > 80) {
            c.image_url = c.image_url.slice(0, 60) + "...[TRUNC]";
          }
          if (typeof c.file_data === "string" && c.file_data.length > 60) {
            c.file_data = c.file_data.slice(0, 40) + "...[TRUNC]";
          }
        });
      }
    });
    if (safe.instructions) {
      safe.instructions = `(${safe.instructions.length} chars)`;
    }
    // eslint-disable-next-line no-console
    console.log("URL:", captured.url);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(safe, null, 2));

    expect(parsed.input).toBeInstanceOf(Array);

    const userItem = parsed.input.find(
      (it) =>
        it.role === "user" &&
        Array.isArray(it.content) &&
        it.content.some((c) => c.type === "input_image"),
    );
    expect(userItem, "expected an input item with an input_image block").toBeDefined();

    const imgBlock = userItem.content.find((c) => c.type === "input_image");
    expect(typeof imgBlock.image_url).toBe("string");
    expect(imgBlock.image_url.startsWith("data:image/")).toBe(true);
  });
});
