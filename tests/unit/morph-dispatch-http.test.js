import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMorphCapability } from "../../src/app/api/morph/_dispatch.js";

describe("Morph dispatch upstream HTTP mapping", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["apply", "/v1/chat/completions"],
    ["compact", "/v1/compact"],
    ["embeddings", "/v1/embeddings"],
    ["rerank", "/v1/rerank"],
    ["warpgrep", "/v1/chat/completions"],
  ])("routes %s to %s", async (capability, expectedPath) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ capability }), {
      status: 207,
      headers: { "Content-Type": "application/json", "X-Upstream-Path": expectedPath },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const requestBody = JSON.stringify({ capability, payload: true });
    const request = new Request(`http://localhost/api/morph/${capability}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    const response = await dispatchMorphCapability({
      capability,
      req: request,
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: ["mk-test"],
        roundRobinEnabled: false,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.morphllm.com${expectedPath}`);
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer mk-test",
        "Content-Type": "application/json",
      },
      body: requestBody,
    });
    expect(response.status).toBe(207);
    expect(response.headers.get("X-Upstream-Path")).toBe(expectedPath);
    await expect(response.json()).resolves.toEqual({ capability });
  });
});
