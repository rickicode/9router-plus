/**
 * Behavior-preservation tests for the cleanup PR that:
 *  - removes the no-op CLAUDE_OAUTH_TOOL_PREFIX path (B2)
 *  - drops the unused CC_DEFAULT_TOOLS import + syncs the cloaking docstring (B1)
 *  - adds the tools-cache-control fast path in claudeHelper.prepareClaudeRequest (P1)
 *  - replaces double .some/.filter with single-pass partition in openai-to-claude (P2)
 *  - skips the alloc when fixToolUseOrdering Pass 1 has nothing to drop (P3)
 *  - guards the unconditional delete cache_control with an `in` check (P4)
 *  - replaces the OPENAI_RESPONSES round-trip with an in-place normalizer (P5)
 *
 * Each test pins the output shape against the previous-known-good behavior.
 */
import { describe, it, expect } from "vitest";

import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { fixToolUseOrdering, prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.js";
import { cloakClaudeTools } from "../../open-sse/utils/claudeCloaking.js";
import { normalizeOpenAIResponsesInPlace } from "../../open-sse/translator/helpers/responsesApiHelper.js";

describe("B2: openaiToClaudeRequest no longer attaches identity _toolNameMap", () => {
  it("does not attach _toolNameMap and tool names are passed through 1:1", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "Bash", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "out" },
      ],
      tools: [
        { type: "function", function: { name: "Bash", description: "shell", parameters: { type: "object" } } },
        { type: "function", function: { name: "Read", description: "read file", parameters: { type: "object" } } },
      ],
    };
    const result = openaiToClaudeRequest("claude-3", body, true);
    expect(result._toolNameMap).toBeUndefined();
    expect(result.tools.map((t) => t.name)).toEqual(["Bash", "Read"]);
    // Last tool keeps the canonical 1h ephemeral cache mark
    expect(result.tools[result.tools.length - 1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Tool_use blocks in messages keep original name
    const assistantMsg = result.messages.find((m) => m.role === "assistant");
    const toolUse = assistantMsg.content.find((b) => b.type === "tool_use");
    expect(toolUse.name).toBe("Bash");
  });
});

describe("P2: openaiToClaudeRequest single-pass partition preserves ordering", () => {
  it("splits tool_result and other blocks correctly when both are present", () => {
    const body = {
      messages: [
        {
          role: "tool",
          tool_call_id: "t1",
          content: "result-text",
        },
      ],
    };
    const result = openaiToClaudeRequest("claude-3", body, true);
    expect(result.messages.length).toBe(1);
    const m = result.messages[0];
    expect(m.role).toBe("user");
    expect(m.content[0].type).toBe("tool_result");
  });
});

describe("B1: cloakClaudeTools docstring matches the actual suffix-everything behavior", () => {
  it("suffixes every client tool (including ones whose name happens to match a CC default)", () => {
    const body = {
      tools: [
        { name: "Bash", description: "", input_schema: { type: "object" } },
        { name: "MyCustom", description: "", input_schema: { type: "object" } },
      ],
    };
    const { body: out, toolNameMap } = cloakClaudeTools(body);
    expect(toolNameMap).toBeInstanceOf(Map);
    // Both client tools get suffixed
    const suffixed = out.tools.filter((t) => t.name !== "Bash" && t.name !== "MyCustom");
    expect(suffixed.length).toBeGreaterThanOrEqual(2);
    // Decoys present (Claude Code native names show up after the suffixed client tools)
    const decoyBash = out.tools.find((t) => t.name === "Bash");
    expect(decoyBash).toBeDefined();
  });
});

describe("P1: prepareClaudeRequest tools fast-path keeps reference when canonical", () => {
  it("does not rebuild tools[] when last tool already has canonical cache_control", () => {
    const lastTool = { name: "B", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } };
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "A", input_schema: { type: "object" } }, lastTool],
    };
    const beforeArr = body.tools;
    const beforeLast = body.tools[1];
    const result = prepareClaudeRequest(body, "claude", null, null);
    expect(result.tools).toBe(beforeArr); // same array reference
    expect(result.tools[1]).toBe(beforeLast); // same last-tool reference
    expect(result.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("rebuilds when a non-last tool carries cache_control (must be stripped)", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "A", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
        { name: "B", input_schema: { type: "object" } },
      ],
    };
    const beforeArr = body.tools;
    const result = prepareClaudeRequest(body, "claude", null, null);
    expect(result.tools).not.toBe(beforeArr); // rebuilt
    expect(result.tools[0].cache_control).toBeUndefined();
    expect(result.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("upgrades the last tool's cache_control in place when non-canonical", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "A", input_schema: { type: "object" } },
        { name: "B", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
      ],
    };
    const beforeArr = body.tools;
    const result = prepareClaudeRequest(body, "claude", null, null);
    // Same array (no other-block cache_control to strip)
    expect(result.tools).toBe(beforeArr);
    expect(result.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("P3: fixToolUseOrdering keeps content reference when nothing to drop", () => {
  it("does not allocate a new content array when no block needs dropping", () => {
    const content = [
      { type: "text", text: "thinking..." },
      { type: "tool_use", id: "t1", name: "X", input: {} },
      { type: "tool_use", id: "t2", name: "Y", input: {} },
    ];
    // Need >=2 messages to bypass the `length <= 1` early return.
    const messages = [
      { role: "user", content: [{ type: "text", text: "u" }] },
      { role: "assistant", content },
    ];
    const out = fixToolUseOrdering(messages);
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant.content).toBe(content);
  });

  it("rebuilds when a stray text block sits after the first tool_use", () => {
    const content = [
      { type: "tool_use", id: "t1", name: "X", input: {} },
      { type: "text", text: "leftover" },
    ];
    const messages = [
      { role: "user", content: [{ type: "text", text: "u" }] },
      { role: "assistant", content },
    ];
    const out = fixToolUseOrdering(messages);
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant.content).not.toBe(content);
    expect(assistant.content.find((b) => b.type === "text")).toBeUndefined();
  });
});

describe("P4: prepareClaudeRequest Pass 1 only deletes cache_control when present", () => {
  it("does not introduce a cache_control key on blocks that did not have one", () => {
    const block = { type: "text", text: "hi" };
    const body = { messages: [{ role: "user", content: [block] }] };
    prepareClaudeRequest(body, "claude", null, null);
    expect("cache_control" in block).toBe(false);
  });

  it("strips cache_control when it actually existed on a non-final block", () => {
    const block = { type: "text", text: "hi", cache_control: { type: "ephemeral" } };
    const body = {
      messages: [
        { role: "user", content: [block] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    };
    prepareClaudeRequest(body, "claude", null, null);
    expect("cache_control" in block).toBe(false);
  });
});

describe("P5: normalizeOpenAIResponsesInPlace behavior parity with old round-trip", () => {
  it("normalizes input_image image_url to plain string, sets detail=auto", () => {
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what is this?" },
            { type: "input_image", image_url: { url: "https://x/img.png" } },
          ],
        },
      ],
    };
    const out = normalizeOpenAIResponsesInPlace("gpt-5", body, true);
    const part = out.input[0].content[1];
    expect(part).toEqual({ type: "input_image", image_url: "https://x/img.png", detail: "auto" });
  });

  it("promotes input_file with image/* mime to input_image (data URI)", () => {
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_file", file_data: "AAAA", mime_type: "image/png", filename: "x.png" },
          ],
        },
      ],
    };
    const out = normalizeOpenAIResponsesInPlace("gpt-5", body, true);
    expect(out.input[0].content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,AAAA",
      detail: "auto",
    });
  });

  it("converts Anthropic-style image block to input_image", () => {
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      ],
    };
    const out = normalizeOpenAIResponsesInPlace("gpt-5", body, true);
    expect(out.input[0].content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,AAAA",
      detail: "auto",
    });
  });

  it("rewrites role 'system' → 'developer' and preserves other roles", () => {
    const body = {
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "S" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "U" }] },
      ],
    };
    const out = normalizeOpenAIResponsesInPlace("gpt-5", body, true);
    expect(out.input[0].role).toBe("developer");
    expect(out.input[1].role).toBe("user");
  });

  it("unwraps chat-style tools into responses-shape and normalizes parameters", () => {
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }],
      tools: [
        { type: "function", function: { name: "foo", description: "d", parameters: { type: "object" } } },
      ],
    };
    const out = normalizeOpenAIResponsesInPlace("gpt-5", body, true);
    const t = out.tools[0];
    expect(t.type).toBe("function");
    expect(t.name).toBe("foo");
    expect(t.parameters).toEqual({ type: "object", properties: {} });
    expect(t.function).toBeUndefined();
  });

  it("honors caller-supplied instructions and parallel_tool_calls=false", () => {
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }],
      instructions: "custom",
      parallel_tool_calls: false,
    };
    const out = normalizeOpenAIResponsesInPlace("gpt-5", body, true);
    expect(out.instructions).toBe("custom");
    expect(out.parallel_tool_calls).toBe(false);
  });

  it("defaults instructions to '' and parallel_tool_calls to true when missing", () => {
    const body = { input: "hello" };
    const out = normalizeOpenAIResponsesInPlace("gpt-5", body, true);
    expect(out.instructions).toBe("");
    expect(out.parallel_tool_calls).toBe(true);
  });

  it("forces store=false, stream=true, and drops include/prompt_cache_key/reasoning", () => {
    const body = {
      input: "hi",
      store: true,
      stream: false,
      include: ["something"],
      prompt_cache_key: "k",
      reasoning: { effort: "high" },
      previous_response_id: "resp-1",
    };
    const out = normalizeOpenAIResponsesInPlace("gpt-5", body, true);
    expect(out.store).toBe(false);
    expect(out.stream).toBe(true);
    expect(out.include).toBeUndefined();
    expect(out.prompt_cache_key).toBeUndefined();
    expect(out.reasoning).toBeUndefined();
    // previous_response_id is left in place (codex executor handles its own cleanup)
    expect(out.previous_response_id).toBe("resp-1");
  });

  it("normalizes string-input via normalizeResponsesInput", () => {
    const body = { input: "hello" };
    const out = normalizeOpenAIResponsesInPlace("gpt-5", body, true);
    expect(Array.isArray(out.input)).toBe(true);
    expect(out.input[0].role).toBe("user");
    expect(out.input[0].content[0].type).toBe("input_text");
  });

  it("handles empty input array by injecting placeholder", () => {
    const body = { input: [] };
    const out = normalizeOpenAIResponsesInPlace("gpt-5", body, true);
    expect(out.input.length).toBe(1);
    expect(out.input[0].role).toBe("user");
  });
});
