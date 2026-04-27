import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

describe("Morph settings UI source", () => {
  async function readMorphPageClientSource() {
    const pagePath = path.resolve(
      import.meta.dirname,
      "../../src/app/(dashboard)/dashboard/morph/MorphPageClient.js"
    );

    return fs.readFile(pagePath, "utf8");
  }

  it("includes the baseUrl input", async () => {
    const source = await readMorphPageClientSource();

    expect(source).toContain('handleFieldChange("baseUrl", event.target.value)');
    expect(source).toContain('placeholder="https://api.morphllm.com"');
    expect(source).toContain('>Base URL<');
  });

  it("includes ordered multi-key editor controls", async () => {
    const source = await readMorphPageClientSource();

    expect(source).toContain("<ol className=");
    expect(source).toContain("handleAddApiKey");
    expect(source).toContain("handleRemoveApiKey");
    expect(source).toContain("Add key");
    expect(source).toContain("Remove key");
  });

  it("includes the round-robin toggle", async () => {
    const source = await readMorphPageClientSource();

    expect(source).toContain('type="checkbox"');
    expect(source).toContain('checked={morphSettings.roundRobinEnabled}');
    expect(source).toContain("Round-robin keys");
  });

  it("lists all five Morph route paths in source", async () => {
    const source = await readMorphPageClientSource();

    expect(source).toContain('localPath: "/api/morph/apply"');
    expect(source).toContain('localPath: "/api/morph/compact"');
    expect(source).toContain('localPath: "/api/morph/embeddings"');
    expect(source).toContain('localPath: "/api/morph/rerank"');
    expect(source).toContain('localPath: "/api/morph/warpgrep"');
    expect(source).toContain('upstreamTarget: "POST /v1/chat/completions"');
    expect(source).toContain('upstreamTarget: "POST /v1/compact"');
    expect(source).toContain('upstreamTarget: "POST /v1/embeddings"');
    expect(source).toContain('upstreamTarget: "POST /v1/rerank"');
  });

  it("includes help text about key 0 being primary", async () => {
    const source = await readMorphPageClientSource();

    expect(source).toContain("When round-robin is off, key 0 is primary and later keys are failover-only.");
  });

  it("includes save validation for baseUrl and apiKeys", async () => {
    const source = await readMorphPageClientSource();

    expect(source).toContain('return "Base URL is required.";');
    expect(source).toContain('return "Add at least one Morph API key before saving.";');
    expect(source).toContain("const nextValidationMessage = buildValidationMessage(morphSettings.baseUrl, morphSettings.apiKeys);");
    expect(source).toContain("if (nextValidationMessage)");
  });
});
