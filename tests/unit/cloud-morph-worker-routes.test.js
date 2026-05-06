import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const workerSource = fs.readFileSync(path.join(repoRoot, "cloud/src/index.js"), "utf8");

describe("cloud Morph worker routes", () => {
  it("exposes the same morphllm endpoints as the local app", () => {
    expect(workerSource).toContain('path === "/morphllm/v1/chat/completions"');
    expect(workerSource).toContain('path === "/morphllm/v1/compact"');
    expect(workerSource).toContain('path === "/morphllm/v1/embeddings"');
    expect(workerSource).toContain('path === "/morphllm/v1/rerank"');
    expect(workerSource).toContain('path === "/morphllm/v1/models"');
    expect(workerSource).toContain('path === "/morphllm/chat/completions"');
    expect(workerSource).toContain('path === "/morphllm/compact"');
    expect(workerSource).toContain('path === "/morphllm/embeddings"');
    expect(workerSource).toContain('path === "/morphllm/rerank"');
    expect(workerSource).toContain('path === "/morphllm/models"');
  });

  it("uses runtime morph settings and shared-runtime Morph key failover", () => {
    expect(workerSource).toContain('const morph = runtimeConfig?.settings?.morph;');
    expect(workerSource).toContain('function selectMorphApiKey(runtimeId, morphSettings)');
    expect(workerSource).toContain('function getMorphKeyOrder(runtimeId, morphSettings)');
    expect(workerSource).toContain('morphRotationCursors');
    expect(workerSource).toContain('const apiKeys = getMorphKeyOrder(runtimeId, morph);');
    expect(workerSource).toContain('AbortSignal.timeout(timeoutMs)');
  });
});
