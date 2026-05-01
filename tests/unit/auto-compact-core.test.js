import { describe, expect, it } from "vitest";
import {
  applyCompactedMessages,
  buildAutoCompactPlan,
  normalizeAutoCompactSettings,
} from "../../open-sse/utils/autoCompactCore.js";

describe("auto compact core", () => {
  it("normalizes settings with safe defaults and bounds", () => {
    expect(normalizeAutoCompactSettings()).toEqual({
      enabled: false,
      minMessages: 20,
      compressionRatio: 0.5,
    });
    expect(normalizeAutoCompactSettings({
      enabled: true,
      minMessages: "3",
      compressionRatio: "0.7",
    })).toEqual({
      enabled: true,
      minMessages: 3,
      compressionRatio: 0.7,
    });
    expect(normalizeAutoCompactSettings({
      enabled: true,
      minMessages: 0,
      compressionRatio: 2,
    })).toEqual({
      enabled: true,
      minMessages: 20,
      compressionRatio: 0.5,
    });
  });

  it("builds Morph payload for plain-text chat messages only", () => {
    const body = {
      model: "combo",
      messages: [
        { role: "system", content: "You are concise.", metadata: { keep: true } },
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Current question" },
      ],
    };

    const plan = buildAutoCompactPlan(body, {
      enabled: true,
      minMessages: 4,
      compressionRatio: 0.35,
    });

    expect(plan.ok).toBe(true);
    expect(plan.key).toBe("messages");
    expect(plan.payload).toEqual({
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Current question" },
      ],
      query: "Current question",
      compression_ratio: 0.35,
      preserve_recent: 3,
      include_line_ranges: false,
      include_markers: false,
    });
  });

  it("supports multimodal text arrays and input payloads", () => {
    const plan = buildAutoCompactPlan({
      input: [
        { role: "system", content: [{ type: "input_text", text: "Policy" }] },
        { role: "user", content: [{ type: "input_text", text: "Hello" }, { type: "image_url", image_url: { url: "data:" } }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        { role: "user", content: [{ type: "input_text", text: "Current question" }] },
      ],
    }, { enabled: true, minMessages: 4, compressionRatio: 0.4 });

    expect(plan.ok).toBe(true);
    expect(plan.key).toBe("input");
    expect(plan.messages).toEqual([
      { role: "system", content: "Policy" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Current question" },
    ]);
    expect(plan.payload.query).toBe("Current question");
  });

  it("skips messages with no compactable text", () => {
    expect(buildAutoCompactPlan({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", tool_calls: [] },
      ],
    }, { enabled: true, minMessages: 1 }).reason).toBe("request messages are not compactable");

    expect(buildAutoCompactPlan({
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:" } }] },
      ],
    }, { enabled: true, minMessages: 1 }).reason).toBe("request messages are not compactable");
  });

  it("applies compacted content without dropping original message fields", () => {
    const body = {
      messages: [
        { role: "system", content: "old system", name: "policy" },
        { role: "user", content: "old user", cache_control: { type: "ephemeral" } },
      ],
    };
    const plan = buildAutoCompactPlan(body, { enabled: true, minMessages: 1 });
    const compacted = applyCompactedMessages(body, plan.key, plan.entries, [
      { role: "system", content: "new system" },
      { role: "user", content: "new user" },
    ]);

    expect(compacted).toEqual({
      messages: [
        { role: "system", content: "new system", name: "policy" },
        { role: "user", content: "new user", cache_control: { type: "ephemeral" } },
      ],
    });
    expect(body.messages[0].content).toBe("old system");
  });

  it("restores compacted text back into structured content arrays", () => {
    const body = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "old user" }, { type: "image_url", image_url: { url: "data:" } }] },
        { role: "assistant", content: [{ type: "text", text: "old assistant" }] },
      ],
    };
    const plan = buildAutoCompactPlan(body, { enabled: true, minMessages: 1 });
    const compacted = applyCompactedMessages(body, plan.key, plan.entries, [
      { role: "user", content: "new user" },
      { role: "assistant", content: "new assistant" },
    ]);

    expect(compacted).toEqual({
      input: [
        { role: "user", content: [{ type: "input_text", text: "new user" }, { type: "image_url", image_url: { url: "data:" } }] },
        { role: "assistant", content: [{ type: "text", text: "new assistant" }] },
      ],
    });
  });

  it("rejects incompatible Morph response shapes", () => {
    const body = {
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
      ],
    };
    const plan = buildAutoCompactPlan(body, { enabled: true, minMessages: 1 });

    expect(applyCompactedMessages(body, plan.key, plan.entries, [
      { role: "user", content: "one" },
    ])).toBeNull();
    expect(applyCompactedMessages(body, plan.key, plan.entries, [
      { role: "user", content: "one" },
      { role: "assistant", content: ["bad"] },
    ])).toBeNull();
  });
});
