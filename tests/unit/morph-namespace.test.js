import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const proxySource = fs.readFileSync(path.join(repoRoot, "src/proxy.js"), "utf8");
const dispatchSource = fs.readFileSync(path.join(repoRoot, "src/app/api/morph/_dispatch.js"), "utf8");

describe("Morph namespace wiring", () => {
  it("protects both Morph namespaces in the dashboard matcher", () => {
    expect(proxySource).toContain('"/api/morph/:path*"');
    expect(proxySource).toContain('"/morphllm/:path*"');
  });

  it("keeps the Morph dispatcher isolated from translator-backed /api/v1 handlers", () => {
    expect(dispatchSource).not.toMatch(/src\/app\/api\/v1\//);
    expect(dispatchSource).not.toMatch(/@\/app\/api\/v1\//);
    expect(dispatchSource).not.toMatch(/\.\.\/.*\/api\/v1\//);
  });

  it("resolves upstream paths from MORPH_CAPABILITY_UPSTREAMS", () => {
    expect(dispatchSource).toContain("MORPH_CAPABILITY_UPSTREAMS");
    expect(dispatchSource).toMatch(/MORPH_CAPABILITY_UPSTREAMS\[capability\]/);
  });

  it("uses Morph key failover for key selection and retries", () => {
    expect(dispatchSource).toContain("executeWithMorphKeyFailover");
    expect(dispatchSource).toMatch(/executeWithMorphKeyFailover\(\{/);
  });
});
