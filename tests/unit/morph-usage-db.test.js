import { describe, expect, it } from "vitest";
import { calculateMorphCredits } from "../../src/lib/morphUsageDb.js";

describe("morph usage pricing", () => {
  it("calculates credits from official Morph pricing", () => {
    const result = calculateMorphCredits({
      capability: "apply",
      model: "morph-v3-large",
      tokens: { prompt_tokens: 1000, completion_tokens: 500 },
    });

    expect(result.model).toBe("morph-v3-large");
    expect(result.dollars).toBeCloseTo(0.00185, 8);
    expect(result.credits).toBeCloseTo(185, 5);
  });

  it("falls back to capability default model pricing", () => {
    const result = calculateMorphCredits({
      capability: "compact",
      model: null,
      tokens: { input_tokens: 2000, output_tokens: 1000 },
    });

    expect(result.model).toBe("morph-compactor");
    expect(result.credits).toBeCloseTo(90, 5);
  });
});
