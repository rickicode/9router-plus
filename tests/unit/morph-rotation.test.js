import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMorphDispatchError,
  executeWithMorphKeyFailover,
  getMorphKeyOrder,
  getMorphKeySelectionSnapshot,
  isMorphRetryableError,
  isMorphRetryableStatus,
  resetMorphKeySelectionState,
} from "../../src/lib/morph/keySelection.js";

function keyEntry(email, key, overrides = {}) {
  return {
    email,
    key,
    status: "active",
    isExhausted: false,
    ...overrides,
  };
}

afterEach(() => {
  resetMorphKeySelectionState();
});

describe("Morph key rotation helper", () => {
  it("returns an empty order when no api keys are configured", () => {
    expect(getMorphKeyOrder()).toEqual({ startIndex: -1, keyOrder: [] });
  });

  it("always starts at key 0 when round robin is disabled", () => {
    const first = getMorphKeyOrder({
      apiKeys: [keyEntry("one@example.com", "primary"), keyEntry("two@example.com", "secondary"), keyEntry("three@example.com", "tertiary")],
      roundRobinEnabled: false,
      rotationKey: "apply",
    });
    const second = getMorphKeyOrder({
      apiKeys: [keyEntry("one@example.com", "primary"), keyEntry("two@example.com", "secondary"), keyEntry("three@example.com", "tertiary")],
      roundRobinEnabled: false,
      rotationKey: "apply",
    });

    expect(first).toEqual({
      startIndex: 0,
      keyOrder: [
        { apiKey: "primary", email: "one@example.com", status: "active", isExhausted: false, index: 0, attempt: 0 },
        { apiKey: "secondary", email: "two@example.com", status: "active", isExhausted: false, index: 1, attempt: 1 },
        { apiKey: "tertiary", email: "three@example.com", status: "active", isExhausted: false, index: 2, attempt: 2 },
      ],
    });
    expect(second).toEqual(first);
    expect(getMorphKeySelectionSnapshot()).toEqual(new Map([["apply", 0]]));
  });

  it("rotates deterministically and wraps around when round robin is enabled", () => {
    const apiKeys = [keyEntry("a@example.com", "key-a"), keyEntry("b@example.com", "key-b"), keyEntry("c@example.com", "key-c")];

    expect(getMorphKeyOrder({ apiKeys, roundRobinEnabled: true, rotationKey: "apply" })).toEqual({
      startIndex: 0,
      keyOrder: [
        { apiKey: "key-a", email: "a@example.com", status: "active", isExhausted: false, index: 0, attempt: 0 },
        { apiKey: "key-b", email: "b@example.com", status: "active", isExhausted: false, index: 1, attempt: 1 },
        { apiKey: "key-c", email: "c@example.com", status: "active", isExhausted: false, index: 2, attempt: 2 },
      ],
    });
    expect(getMorphKeyOrder({ apiKeys, roundRobinEnabled: true, rotationKey: "apply" })).toEqual({
      startIndex: 1,
      keyOrder: [
        { apiKey: "key-b", email: "b@example.com", status: "active", isExhausted: false, index: 1, attempt: 0 },
        { apiKey: "key-c", email: "c@example.com", status: "active", isExhausted: false, index: 2, attempt: 1 },
        { apiKey: "key-a", email: "a@example.com", status: "active", isExhausted: false, index: 0, attempt: 2 },
      ],
    });
    expect(getMorphKeyOrder({ apiKeys, roundRobinEnabled: true, rotationKey: "apply" })).toEqual({
      startIndex: 2,
      keyOrder: [
        { apiKey: "key-c", email: "c@example.com", status: "active", isExhausted: false, index: 2, attempt: 0 },
        { apiKey: "key-a", email: "a@example.com", status: "active", isExhausted: false, index: 0, attempt: 1 },
        { apiKey: "key-b", email: "b@example.com", status: "active", isExhausted: false, index: 1, attempt: 2 },
      ],
    });
    expect(getMorphKeyOrder({ apiKeys, roundRobinEnabled: true, rotationKey: "apply" })).toEqual({
      startIndex: 0,
      keyOrder: [
        { apiKey: "key-a", email: "a@example.com", status: "active", isExhausted: false, index: 0, attempt: 0 },
        { apiKey: "key-b", email: "b@example.com", status: "active", isExhausted: false, index: 1, attempt: 1 },
        { apiKey: "key-c", email: "c@example.com", status: "active", isExhausted: false, index: 2, attempt: 2 },
      ],
    });
  });

  it("keeps one-key selection stable even when round robin is enabled", () => {
    expect(getMorphKeyOrder({ apiKeys: [keyEntry("solo@example.com", "solo")], roundRobinEnabled: true, rotationKey: "apply" })).toEqual({
      startIndex: 0,
      keyOrder: [{ apiKey: "solo", email: "solo@example.com", status: "active", isExhausted: false, index: 0, attempt: 0 }],
    });
    expect(getMorphKeyOrder({ apiKeys: [keyEntry("solo@example.com", "solo")], roundRobinEnabled: true, rotationKey: "apply" })).toEqual({
      startIndex: 0,
      keyOrder: [{ apiKey: "solo", email: "solo@example.com", status: "active", isExhausted: false, index: 0, attempt: 0 }],
    });
  });

  it("skips exhausted keys entirely", () => {
    expect(getMorphKeyOrder({
      apiKeys: [
        keyEntry("one@example.com", "key-a", { isExhausted: true, status: "exhausted" }),
        keyEntry("two@example.com", "key-b"),
      ],
      roundRobinEnabled: false,
      rotationKey: "apply",
    })).toEqual({
      startIndex: 0,
      keyOrder: [{ apiKey: "key-b", email: "two@example.com", status: "active", isExhausted: false, index: 0, attempt: 0 }],
    });
  });

  it("skips inactive keys entirely", () => {
    expect(getMorphKeyOrder({
      apiKeys: [
        keyEntry("one@example.com", "key-a", { status: "inactive" }),
        keyEntry("two@example.com", "key-b"),
      ],
      roundRobinEnabled: false,
      rotationKey: "apply",
    })).toEqual({
      startIndex: 0,
      keyOrder: [{ apiKey: "key-b", email: "two@example.com", status: "active", isExhausted: false, index: 0, attempt: 0 }],
    });
  });

  it("retries the same request with the next key after an eligible upstream response failure", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, status: 200, body: { ok: true } });

    const result = await executeWithMorphKeyFailover({
      apiKeys: [keyEntry("one@example.com", "primary"), keyEntry("two@example.com", "secondary"), keyEntry("three@example.com", "tertiary")],
      roundRobinEnabled: false,
      rotationKey: "apply",
      execute,
    });

    expect(result).toEqual({ ok: true, status: 200, body: { ok: true } });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, {
      apiKey: "primary",
      email: "one@example.com",
      status: "active",
      isExhausted: false,
      index: 0,
      attempt: 0,
      startIndex: 0,
      totalKeys: 3,
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      apiKey: "secondary",
      email: "two@example.com",
      status: "active",
      isExhausted: false,
      index: 1,
      attempt: 1,
      startIndex: 0,
      totalKeys: 3,
    });
  });

  it("retries after network and timeout failures once dispatch has started", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        createMorphDispatchError("socket hang up", { code: "ECONNRESET", dispatchStarted: true })
      )
      .mockRejectedValueOnce(
        createMorphDispatchError("timed out", { name: "AbortError", dispatchStarted: true })
      )
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await executeWithMorphKeyFailover({
      apiKeys: [keyEntry("a@example.com", "key-a"), keyEntry("b@example.com", "key-b"), keyEntry("c@example.com", "key-c")],
      roundRobinEnabled: true,
      rotationKey: "rerank",
      execute,
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.map(([attempt]) => attempt.apiKey)).toEqual(["key-a", "key-b", "key-c"]);
  });

  it("fails immediately for non-retryable construction errors before dispatch", async () => {
    const execute = vi.fn().mockRejectedValue(
      createMorphDispatchError("Failed to serialize request body", { dispatchStarted: false })
    );

    await expect(
      executeWithMorphKeyFailover({
        apiKeys: [keyEntry("one@example.com", "primary"), keyEntry("two@example.com", "secondary")],
        roundRobinEnabled: false,
        rotationKey: "compact",
        execute,
      })
    ).rejects.toThrow("Failed to serialize request body");

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("throws when no Morph api key is available", async () => {
    await expect(
      executeWithMorphKeyFailover({
        apiKeys: [],
        execute: vi.fn(),
      })
    ).rejects.toMatchObject({
      message: "Morph proxy requires at least one active API key",
      code: "MORPH_API_KEY_MISSING",
    });
  });

  it("treats only 401, 429, and 5xx responses as retryable statuses", () => {
    expect(isMorphRetryableStatus(401)).toBe(true);
    expect(isMorphRetryableStatus(429)).toBe(true);
    expect(isMorphRetryableStatus(500)).toBe(true);
    expect(isMorphRetryableStatus(503)).toBe(true);
    expect(isMorphRetryableStatus(400)).toBe(false);
    expect(isMorphRetryableStatus(404)).toBe(false);
  });

  it("requires dispatch to start before thrown failures become retryable", () => {
    expect(
      isMorphRetryableError(createMorphDispatchError("401 before dispatch", { status: 401, dispatchStarted: false }))
    ).toBe(false);
    expect(
      isMorphRetryableError(createMorphDispatchError("401 after dispatch", { status: 401, dispatchStarted: true }))
    ).toBe(true);
    expect(
      isMorphRetryableError(createMorphDispatchError("network after dispatch", { dispatchStarted: true }))
    ).toBe(true);
  });
});
