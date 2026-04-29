import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const morphRoutePaths = [
  "src/app/api/morph/_dispatch.js",
  "src/app/morphllm/v1/chat/completions/route.js",
  "src/app/morphllm/v1/compact/route.js",
  "src/app/morphllm/v1/embeddings/route.js",
  "src/app/morphllm/v1/rerank/route.js",
  "src/app/morphllm/v1/models/route.js",
];

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("Morph raw proxy regression guards", () => {
  it("keeps all Morph route modules isolated from /api/v1 imports", () => {
    for (const relativePath of morphRoutePaths) {
      const source = readRepoFile(relativePath);

      expect(source, relativePath).not.toMatch(/src\/app\/api\/v1\//);
      expect(source, relativePath).not.toMatch(/@\/app\/api\/v1\//);
      expect(source, relativePath).not.toMatch(/\.\.\/.*\/api\/v1\//);
    }
  });

  it("keeps the dispatcher isolated from translator-backed handlers", () => {
    const dispatchSource = readRepoFile("src/app/api/morph/_dispatch.js");

    expect(dispatchSource).not.toMatch(/translator/i);
    expect(dispatchSource).not.toMatch(/handle[A-Z]\w+/);
    expect(dispatchSource).not.toContain("@/sse/handlers/");
    expect(dispatchSource).not.toContain("open-sse/");
  });

  it("protects both Morph namespaces in the proxy matcher", () => {
    const proxySource = readRepoFile("src/proxy.js");

    expect(proxySource).toContain('"/api/morph/:path*"');
    expect(proxySource).toContain('"/morphllm/:path*"');
  });

  it("only exposes explicit Morph LLM rewrites through /morphllm", () => {
    const nextConfigSource = readRepoFile("next.config.mjs");

        expect(nextConfigSource).not.toContain('source: "/morphllm/:path*"');
    expect(nextConfigSource).not.toContain('source: "/morphllm"');
    expect(nextConfigSource).not.toContain('destination: "/api/morph/:path*"');
    expect(nextConfigSource).not.toContain('destination: "/api/morph"');
    expect(nextConfigSource).not.toContain('source: "/morphllm/v1/chat/completions"');
  });

  it("keeps Morph key selection isolated from provider-generic modules", () => {
    const keySelectionSource = readRepoFile("src/lib/morph/keySelection.js");

    expect(keySelectionSource).not.toMatch(/^import\s/m);
    expect(keySelectionSource).not.toContain("provider");
    expect(keySelectionSource).not.toContain("localDb");
  });

  it("keeps the existing /api/v1/embeddings route on the standard handler only", () => {
    const embeddingsRouteSource = readRepoFile("src/app/api/v1/embeddings/route.js");

    expect(embeddingsRouteSource).not.toContain("routeMorphV1Capability");
    expect(embeddingsRouteSource).toContain('import { handleEmbeddings } from "@/sse/handlers/embeddings.js";');
    expect(embeddingsRouteSource).toContain("return await handleEmbeddings(request);");
  });
});
