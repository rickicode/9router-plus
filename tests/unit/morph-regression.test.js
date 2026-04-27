import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const morphRoutePaths = [
  "src/app/api/morph/apply/route.js",
  "src/app/api/morph/compact/route.js",
  "src/app/api/morph/embeddings/route.js",
  "src/app/api/morph/rerank/route.js",
  "src/app/api/morph/warpgrep/route.js",
  "src/app/api/morph/_dispatch.js",
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

  it("protects the /api/morph namespace in the proxy matcher", () => {
    const proxySource = readRepoFile("src/proxy.js");

    expect(proxySource).toContain('"/api/morph/:path*"');
  });

  it("keeps Morph key selection isolated from provider-generic modules", () => {
    const keySelectionSource = readRepoFile("src/lib/morph/keySelection.js");

    expect(keySelectionSource).not.toMatch(/^import\s/m);
    expect(keySelectionSource).not.toContain("provider");
    expect(keySelectionSource).not.toContain("localDb");
  });

  it("keeps the existing /api/v1/embeddings route unchanged", () => {
    const embeddingsRouteSource = readRepoFile("src/app/api/v1/embeddings/route.js");

    expect(embeddingsRouteSource).toBe([
      'import { handleEmbeddings } from "@/sse/handlers/embeddings.js";',
      "",
      "/**",
      " * Handle CORS preflight",
      " */",
      "export async function OPTIONS() {",
      "  return new Response(null, {",
      "    headers: {",
      '      "Access-Control-Allow-Origin": "*",',
      '      "Access-Control-Allow-Methods": "POST, OPTIONS",',
      '      "Access-Control-Allow-Headers": "*"',
      "    }",
      "  });",
      "}",
      "",
      "/**",
      " * POST /v1/embeddings - OpenAI-compatible embeddings endpoint",
      " */",
      "export async function POST(request) {",
      "  return await handleEmbeddings(request);",
      "}",
      "",
    ].join("\n"));
  });
});
