/**
 * Behavior-preservation tests for translator perf optimizations:
 *  - fixToolUseOrdering single-pass partition + clone-skip (Fix #1)
 *  - prepareClaudeRequest system rebuild fast-path (Fix #3)
 *  - openaiToClaudeRequest single-pass system extraction (Fix #4)
 */

import { describe, it, expect } from "vitest";
import { fixToolUseOrdering, prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

describe("fixToolUseOrdering", () => {
  it("drops text blocks AFTER tool_use in assistant content", () => {
    const messages = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "tool_use", id: "t1", name: "search", input: {} },
          { type: "text", text: "after-should-be-dropped" },
        ],
      },
    ];
    const out = fixToolUseOrdering(messages);
    expect(out).toHaveLength(2);
    const blocks = out[1].content;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "before" });
    expect(blocks[1].type).toBe("tool_use");
  });

  it("keeps thinking blocks even after tool_use", () => {
    const messages = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "tool_use", id: "t1", name: "search", input: {} },
          { type: "thinking", thinking: "..." },
        ],
      },
    ];
    const out = fixToolUseOrdering(messages);
    expect(out[1].content).toHaveLength(3);
    expect(out[1].content[2].type).toBe("thinking");
  });

  it("merges consecutive same-role messages with tool_results sorted first", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "text", text: "follow-up" },
        ],
      },
    ];
    const out = fixToolUseOrdering(messages);
    expect(out).toHaveLength(1);
    expect(out[0].content[0].type).toBe("tool_result");
    expect(out[0].content[1].type).toBe("text");
    expect(out[0].content[2].type).toBe("text");
  });

  it("does not merge when roles differ", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hi back" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ];
    const out = fixToolUseOrdering(messages);
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("normalizes string content into a text block during merge", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "user", content: "world" },
    ];
    const out = fixToolUseOrdering(messages);
    expect(out).toHaveLength(1);
    expect(out[0].content).toHaveLength(2);
    expect(out[0].content[0]).toEqual({ type: "text", text: "hello" });
    expect(out[0].content[1]).toEqual({ type: "text", text: "world" });
  });

  it("returns single-element messages unchanged", () => {
    const messages = [{ role: "user", content: "only" }];
    const out = fixToolUseOrdering(messages);
    expect(out).toBe(messages);
  });
});

describe("prepareClaudeRequest system rebuild fast-path", () => {
  it("adds canonical cache_control to last block when none present", () => {
    const body = {
      system: [
        { type: "text", text: "first" },
        { type: "text", text: "last" },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = prepareClaudeRequest(body);
    expect(out.system[0].cache_control).toBeUndefined();
    expect(out.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("rewrites last block to canonical TTL when prior shape lacked ttl", () => {
    const body = {
      system: [
        { type: "text", text: "first" },
        { type: "text", text: "last", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = prepareClaudeRequest(body);
    expect(out.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("strips cache_control from non-last blocks (rebuild path)", () => {
    const body = {
      system: [
        { type: "text", text: "first", cache_control: { type: "ephemeral" } },
        { type: "text", text: "last" },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = prepareClaudeRequest(body);
    expect(out.system[0].cache_control).toBeUndefined();
    expect(out.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("is idempotent when system is already canonical", () => {
    const body = {
      system: [
        { type: "text", text: "first" },
        { type: "text", text: "last", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const before = JSON.stringify(body.system);
    const out = prepareClaudeRequest(body);
    expect(JSON.stringify(out.system)).toBe(before);
  });
});

describe("openaiToClaudeRequest single-pass system extraction", () => {
  it("preserves order of multiple system messages", () => {
    const body = {
      messages: [
        { role: "system", content: "alpha" },
        { role: "user", content: "u1" },
        { role: "system", content: "beta" },
        { role: "user", content: "u2" },
      ],
    };
    const out = openaiToClaudeRequest("claude-sonnet-4.5", body, false);
    const sysText = out.system
      .filter((s) => s.type === "text")
      .map((s) => s.text)
      .join("|");
    expect(sysText).toContain("alpha");
    expect(sysText).toContain("beta");
    expect(sysText.indexOf("alpha")).toBeLessThan(sysText.indexOf("beta"));
    // user messages should be merged into a single user role since they were consecutive after system filtering
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("user");
  });

  it("does not lose user/assistant ordering when system messages interleave", () => {
    const body = {
      messages: [
        { role: "user", content: "u1" },
        { role: "system", content: "sys" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    };
    const out = openaiToClaudeRequest("claude-sonnet-4.5", body, false);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});
