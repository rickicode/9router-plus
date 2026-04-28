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

  it("hides the baseUrl input and describes local-only routing", async () => {
    const source = await readMorphPageClientSource();

    expect(source).not.toContain('handleFieldChange("baseUrl", event.target.value)');
    expect(source).not.toContain('placeholder="https://api.morphllm.com"');
    expect(source).not.toContain('>Base URL<');
    expect(source).toContain("local 9Router endpoints");
    expect(source).toContain("backend-only upstream URL");
  });

  it("includes ordered multi-key editor controls", async () => {
    const source = await readMorphPageClientSource();

    expect(source).toContain("<ol className=");
    expect(source).toContain("handleAddApiKey");
    expect(source).toContain("handleRemoveApiKey");
    expect(source).toContain("parseBulkMorphApiKeys");
    expect(source).toContain("Bulk import Morph API keys");
    expect(source).toContain("email|apikey");
    expect(source).toContain('fetch("/api/morph/test-key"');
    expect(source).toContain("Test key");
    expect(source).toContain("Test all keys");
    expect(source).toContain("Add key");
    expect(source).toContain("Remove key");
    expect(source).toContain("validate them immediately");
    expect(source).toContain("Checking key status...");
    expect(source).toContain("Invalid and exhausted keys are skipped");
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

    expect(source).toContain("When round-robin is off, the first active email stays primary and later emails are failover-only.");
  });

  it("adds a dedicated Usage tab and isolated Morph usage copy", async () => {
    const source = await readMorphPageClientSource();
    const byEmailSection = source.slice(
      source.indexOf('title="By email"'),
      source.indexOf('title="Request logs"') === -1 ? undefined : source.indexOf('title="Request logs"')
    );

    expect(source).toContain('{ value: "usage", label: "Usage" }');
    expect(source).toContain("Isolated Morph usage");
    expect(source).toContain("Review Morph-only requests, token flow, and estimated credits.");
    expect(source).toContain('fetch(`/api/morph/usage/stats?period=${usagePeriod}`)');
    expect(source).toContain('fetch("/api/morph/usage/requests?limit=200")');
    expect(source).toContain("By email");
    expect(source).toContain("Serving-key ownership across token flow, requests, and credits");
    expect(source).toContain("Search email or token usage");
    expect(source).toContain("String(value?.inputTokens ?? \"\").toLowerCase()");
    expect(source).toContain("String(value?.outputTokens ?? \"\").toLowerCase()");
    expect(source).toContain("String(value?.requests ?? \"\").toLowerCase()");
    expect(source).toContain("String(value?.credits ?? \"\").toLowerCase()");
    expect(source).toContain("fmtNumber(value?.inputTokens).toLowerCase()");
    expect(source).toContain("fmtNumber(value?.outputTokens).toLowerCase()");
    expect(source).toContain("fmtNumber(value?.requests).toLowerCase()");
    expect(source).toContain("fmtCredits(value?.credits).toLowerCase()");
    expect(source).toContain("Every Morph request is recorded separately");
    expect(source).toContain("Capability filter");
    expect(source).toContain("Auto refresh (5s)");
    expect(byEmailSection).toContain("Email");
    expect(source).toContain("Showing {fmtNumber(filteredEmailUsageEntries.length)} group");
    expect(source).toContain("entry.apiKeyLabel || \"Unknown email\"");
    expect(source).toContain("In {fmtNumber(entry.inputTokens)}");
    expect(source).toContain("Out {fmtNumber(entry.outputTokens)}");
    expect(byEmailSection).toContain("<th className=\"py-2\">Email</th>");
    expect(byEmailSection).toContain(">In</th>");
    expect(byEmailSection).toContain(">Out</th>");
    expect(byEmailSection).toContain(">Req</th>");
    expect(byEmailSection).toContain(">Credits</th>");
    expect(byEmailSection).not.toContain("<th className=\"py-2\">Capability</th>");
    expect(source).not.toContain("<th className=\"px-4 py-3\">Entrypoint</th>");
    expect(source).toContain("Previous");
    expect(source).toContain("Next");
  });

  it("rounds displayed Morph credits and keeps validation focused on having keys present", async () => {
    const source = await readMorphPageClientSource();

    expect(source).toContain("maximumFractionDigits: 0");
    expect(source).toContain('return "Add at least one Morph API key.";');
    expect(source).toContain("await persistMorphSettings(nextSettings);");
    expect(source).toContain('status: entry.status || "inactive"');
    expect(source).not.toContain("Save Morph settings");
    expect(source).not.toContain('return "Base URL is required."');
  });
});
