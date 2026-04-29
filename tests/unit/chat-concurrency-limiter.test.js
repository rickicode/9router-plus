import { beforeEach, describe, expect, it } from "vitest";
import {
  attachChatSlotRelease,
  getChatLimiterSnapshot,
  resetChatLimiterForTests,
  tryAcquireChatSlot,
} from "../../src/lib/chat/concurrencyLimiter.js";

describe("chat concurrency limiter", () => {
  beforeEach(() => {
    resetChatLimiterForTests();
  });

  it("rejects when global capacity is exhausted", () => {
    const limits = { maxInflight: 1, providerMaxInflight: 10, accountMaxInflight: 10 };
    const first = tryAcquireChatSlot({ provider: "openai", connectionId: "a", limits });
    const second = tryAcquireChatSlot({ provider: "openai", connectionId: "b", limits });

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, status: 503 });
    first.release();
    expect(getChatLimiterSnapshot().global).toBe(0);
  });

  it("rejects when account capacity is exhausted", () => {
    const limits = { maxInflight: 10, providerMaxInflight: 10, accountMaxInflight: 1 };
    const first = tryAcquireChatSlot({ provider: "openai", connectionId: "a", limits });
    const second = tryAcquireChatSlot({ provider: "openai", connectionId: "a", limits });

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, status: 429 });
    first.release();
  });

  it("releases a slot after response body is consumed", async () => {
    const slot = tryAcquireChatSlot({ provider: "openai", connectionId: "a" });
    const response = attachChatSlotRelease(new Response("ok"), slot.release);

    expect(getChatLimiterSnapshot().global).toBe(1);
    await response.text();
    expect(getChatLimiterSnapshot().global).toBe(0);
  });
});
