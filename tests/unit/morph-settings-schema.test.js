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

  it("trims baseUrl and normalizes apiKeys while preserving first-seen order", () => {
    expect(
      normalizeMorphSettings({
        baseUrl: "  https://proxy.example.com/base  ",
        apiKeys: ["  key-a  ", "", " key-b ", "key-a", "   ", "key-c", "key-b"],
        roundRobinEnabled: true,
      })
    ).toEqual({
      baseUrl: "https://proxy.example.com/base",
      apiKeys: ["key-a", "key-b", "key-c"],
      roundRobinEnabled: true,
    });
  });

  it("drops non-string apiKeys while keeping exact duplicates out", () => {
    expect(
      normalizeMorphSettings({
        apiKeys: ["first", null, "second", 123, "first", undefined, "third"],
      })
    ).toEqual({
      baseUrl: "https://api.morphllm.com",
      apiKeys: ["first", "second", "third"],
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
