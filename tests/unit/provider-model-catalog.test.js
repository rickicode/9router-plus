import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";

describe("provider model catalog", () => {
  it("includes gpt-5.5 for codex and openai", () => {
    expect(PROVIDER_MODELS.cx.some((model) => model.id === "gpt-5.5")).toBe(true);
    expect(PROVIDER_MODELS.openai.some((model) => model.id === "gpt-5.5")).toBe(true);
  });
});
