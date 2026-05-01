import { describe, expect, it } from "vitest";
import { MORPH_CAPABILITY_UPSTREAMS, normalizeMorphSettings } from "../../src/lib/localDb.js";

describe("Morph settings schema", () => {
  it("uses canonical defaults", () => {
    expect(normalizeMorphSettings()).toEqual({
      baseUrl: "https://api.morphllm.com",
      apiKeys: [],
      roundRobinEnabled: false,
    });
  });

  it("trims baseUrl and normalizes email-based apiKeys while replacing duplicate emails with the latest key", () => {
    expect(
      normalizeMorphSettings({
        baseUrl: "  https://proxy.example.com/base  ",
        apiKeys: [
          { email: "  one@example.com  ", key: "  key-a  " },
          { email: "two@example.com", key: " key-b " },
          { email: "one@example.com", key: "key-a-new" },
        ],
        roundRobinEnabled: true,
      })
    ).toEqual({
      baseUrl: "https://proxy.example.com/base",
      apiKeys: [
        {
          email: "one@example.com",
          key: "key-a-new",
          status: "unknown",
          isExhausted: false,
          lastCheckedAt: null,
          lastError: "",
        },
        {
          email: "two@example.com",
          key: "key-b",
          status: "unknown",
          isExhausted: false,
          lastCheckedAt: null,
          lastError: "",
        },
      ],
      roundRobinEnabled: true,
    });
  });

  it("converts legacy string apiKeys into local email entries and drops invalid non-string values", () => {
    expect(
      normalizeMorphSettings({
        apiKeys: ["first", null, "second", 123, "first", undefined, "third"],
      })
    ).toEqual({
      baseUrl: "https://api.morphllm.com",
      apiKeys: [
        {
          email: "key1@local",
          key: "first",
          status: "unknown",
          isExhausted: false,
          lastCheckedAt: null,
          lastError: "",
        },
        {
          email: "key3@local",
          key: "second",
          status: "unknown",
          isExhausted: false,
          lastCheckedAt: null,
          lastError: "",
        },
        {
          email: "key5@local",
          key: "first",
          status: "unknown",
          isExhausted: false,
          lastCheckedAt: null,
          lastError: "",
        },
        {
          email: "key7@local",
          key: "third",
          status: "unknown",
          isExhausted: false,
          lastCheckedAt: null,
          lastError: "",
        },
      ],
      roundRobinEnabled: false,
    });
  });

  it("rejects invalid absolute URLs deterministically", () => {
    expect(() => normalizeMorphSettings({ baseUrl: "not-a-url" })).toThrow(
      "Morph base URL must be a valid absolute http(s) URL"
    );
    expect(() => normalizeMorphSettings({ baseUrl: "/relative/path" })).toThrow(
      "Morph base URL must be a valid absolute http(s) URL"
    );
  });

  it("documents the exact upstream path mapping for each Morph capability", () => {
    expect(MORPH_CAPABILITY_UPSTREAMS).toEqual({
      apply: { method: "POST", path: "/v1/chat/completions" },
      warpgrep: { method: "POST", path: "/v1/chat/completions" },
      compact: { method: "POST", path: "/v1/compact" },
      embeddings: { method: "POST", path: "/v1/embeddings" },
      rerank: { method: "POST", path: "/v1/rerank" },
    });
  });
});
