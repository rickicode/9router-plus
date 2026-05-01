import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMorphCapability } from "../../src/app/api/morph/_dispatch.js";
import * as morphUsageDb from "../../src/lib/morphUsageDb.js";
import * as usageDb from "../../src/lib/usageDb.js";
import * as localDb from "../../src/lib/localDb.js";

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
    const trackPendingRequestSpy = vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    const saveMorphUsageSpy = vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    const atomicUpdateSettingsSpy = vi.spyOn(localDb, "atomicUpdateSettings").mockImplementation(async (mutator) => mutator({ morph: { apiKeys: [{ email: "owner@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false, lastError: "" }] } }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ capability, usage: { prompt_tokens: 12, completion_tokens: 34 } }), {
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
        apiKeys: [{ email: "owner@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false }],
        roundRobinEnabled: false,
      },
    });

    expect(trackPendingRequestSpy).toHaveBeenNthCalledWith(1, `morph:${capability}`, "morph", capability, true, false, expect.any(Object));
    expect(trackPendingRequestSpy).toHaveBeenNthCalledWith(2, `morph:${capability}`, "morph", capability, false, false, expect.any(Object));
    expect(saveMorphUsageSpy).toHaveBeenCalledWith(expect.objectContaining({
      capability,
      entrypoint: `/api/morph/${capability}`,
      source: "morph-api",
      apiKey: "TEST_MORPH_KEY_A",
      apiKeyLabel: "owner@example.com",
      tokens: {
        prompt_tokens: 12,
        completion_tokens: 34,
        input_tokens: 12,
        output_tokens: 34,
      },
      status: "ok",
    }), { propagateError: true });
    expect(atomicUpdateSettingsSpy).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.morphllm.com${expectedPath}`);
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer TEST_MORPH_KEY_A",
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
      },
      body: requestBody,
    });
    expect(options.signal).toBeDefined();
    expect(response.status).toBe(207);
    expect(response.headers.get("X-Upstream-Path")).toBe(expectedPath);
    await expect(response.json()).resolves.toEqual({ capability, usage: { prompt_tokens: 12, completion_tokens: 34 } });
  });

  it("records bridged /v1 Morph requests as Morph usage", async () => {
    vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const saveMorphUsageSpy = vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "morph-v3-large", messages: [] }),
    });

    const requestBody = JSON.stringify({ model: "morph-v3-large", messages: [] });
    const requestPayload = { model: "morph-v3-large", messages: [] };

    await dispatchMorphCapability({
      capability: "apply",
      req: request,
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [{ email: "bridge@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false }],
        roundRobinEnabled: false,
      },
      requestBody,
      requestPayload,
    });

    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(saveMorphUsageSpy).toHaveBeenCalledWith(expect.objectContaining({
      entrypoint: "/v1/chat/completions",
      source: "v1",
      model: "morph-v3-large",
      requestedModel: "morph-v3-large",
      apiKey: "TEST_MORPH_KEY_A",
      apiKeyLabel: "bridge@example.com",
    }), { propagateError: true });
  });

  it("logs raw Morph v1 chat-completions access without capability translation labels", async () => {
    vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    vi.spyOn(localDb, "atomicUpdateSettings").mockImplementation(async (mutator) => mutator({
      morph: {
        apiKeys: [{ email: "raw@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false, lastError: "" }],
      },
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, usage: { prompt_tokens: 1, completion_tokens: 2 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await dispatchMorphCapability({
      capability: "apply",
      req: new Request("http://localhost/morphllm/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "morph-v3-large", messages: [] }),
      }),
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [{ email: "raw@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false }],
        roundRobinEnabled: false,
      },
      upstreamTarget: { method: "POST", path: "/v1/chat/completions" },
      requestLabel: "morph:/v1/chat/completions",
    });

    expect(consoleLogSpy).toHaveBeenCalledWith("\x1b[38;5;205m[morph] POST /morphllm/v1/chat/completions upstream=/v1/chat/completions model=morph-v3-large\x1b[0m");
  });

  it.each([
    ["apply", "/morphllm/v1/chat/completions", "/v1/chat/completions", "morph-v3-large"],
    ["compact", "/morphllm/v1/compact", "/v1/compact", "morph-compactor"],
    ["embeddings", "/morphllm/v1/embeddings", "/v1/embeddings", "morph-embedding-v4"],
    ["rerank", "/morphllm/v1/rerank", "/v1/rerank", "morph-rerank-v4"],
  ])("logs Morph endpoint access for %s", async (capability, pathName, upstreamPath, model) => {
    vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    vi.spyOn(localDb, "atomicUpdateSettings").mockImplementation(async (mutator) => mutator({
      morph: {
        apiKeys: [{ email: "logger@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false, lastError: "" }],
      },
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, usage: { prompt_tokens: 1, completion_tokens: 2 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await dispatchMorphCapability({
      capability,
      req: new Request(`http://localhost${pathName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model, messages: [] }),
      }),
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [{ email: "logger@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false }],
        roundRobinEnabled: false,
      },
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(`\x1b[38;5;205m[morph] POST ${pathName} upstream=${upstreamPath} model=${model}\x1b[0m`);
  });

  it("logs request completion as error when upstream fetch fails", async () => {
    const trackPendingRequestSpy = vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    const saveMorphUsageSpy = vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("boom");
    }));

    const request = new Request("http://localhost/morphllm/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    await expect(dispatchMorphCapability({
      capability: "apply",
      req: request,
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [{ email: "error@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false }],
        roundRobinEnabled: false,
      },
    })).rejects.toThrow("Morph upstream request failed");

    expect(trackPendingRequestSpy).toHaveBeenNthCalledWith(1, "morph:apply", "morph", "apply", true, false, expect.any(Object));
    expect(trackPendingRequestSpy).toHaveBeenNthCalledWith(2, "morph:apply", "morph", "apply", false, true, expect.any(Object));
    expect(saveMorphUsageSpy).toHaveBeenCalledWith(expect.objectContaining({
      capability: "apply",
      status: "error",
      apiKey: "TEST_MORPH_KEY_A",
      apiKeyLabel: "error@example.com",
      error: expect.stringContaining("Morph upstream request failed"),
    }), { propagateError: true });
  });

  it("marks keys exhausted when Morph returns a quota-like failure", async () => {
    vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    const saveMorphUsageSpy = vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    const atomicUpdateSettingsSpy = vi.spyOn(localDb, "atomicUpdateSettings").mockImplementation(async (mutator) => mutator({ morph: { apiKeys: [{ email: "quota@example.com", key: "TEST_MORPH_KEY_B" }] } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("credit exhausted", {
      status: 429,
      headers: { "Content-Type": "application/json" },
    })));

    const request = new Request("http://localhost/morphllm/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    await dispatchMorphCapability({
      capability: "apply",
      req: request,
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [{ email: "quota@example.com", key: "TEST_MORPH_KEY_B", status: "active", isExhausted: false }],
        roundRobinEnabled: false,
      },
    });

    expect(saveMorphUsageSpy).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "TEST_MORPH_KEY_B",
      apiKeyLabel: "quota@example.com",
    }), { propagateError: true });
    expect(atomicUpdateSettingsSpy).toHaveBeenCalled();
  });

  it("marks invalid keys inactive and retries with the next key before responding", async () => {
    vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    const atomicUpdateSettingsSpy = vi.spyOn(localDb, "atomicUpdateSettings").mockImplementation(async (mutator) => mutator({ morph: { apiKeys: [] } }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("invalid api key", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, usage: { prompt_tokens: 1, completion_tokens: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("http://localhost/morphllm/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    const response = await dispatchMorphCapability({
      capability: "apply",
      req: request,
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [
          { email: "invalid@example.com", key: "TEST_MORPH_KEY_INVALID", status: "active", isExhausted: false },
          { email: "healthy@example.com", key: "TEST_MORPH_KEY_HEALTHY", status: "active", isExhausted: false },
        ],
        roundRobinEnabled: false,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer TEST_MORPH_KEY_INVALID");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer TEST_MORPH_KEY_HEALTHY");
    expect(atomicUpdateSettingsSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, usage: { prompt_tokens: 1, completion_tokens: 2 } });
  });

  it("skips settings writes when a successful key is already marked active", async () => {
    vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    const atomicUpdateSettingsSpy = vi.spyOn(localDb, "atomicUpdateSettings").mockImplementation(async (mutator) => mutator({
      morph: {
        apiKeys: [{ email: "steady@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false, lastError: "" }],
      },
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 6 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await dispatchMorphCapability({
      capability: "apply",
      req: new Request("http://localhost/morphllm/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }),
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [{ email: "steady@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false }],
        roundRobinEnabled: false,
      },
    });

    expect(atomicUpdateSettingsSpy).toHaveBeenCalledTimes(0);
  });

  it("writes healthy state in the background when a key needs recovery", async () => {
    vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    const atomicUpdateSettingsSpy = vi.spyOn(localDb, "atomicUpdateSettings").mockImplementation(async (mutator) => mutator({
      morph: {
        apiKeys: [{ email: "recover@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false, lastError: "401" }],
      },
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 6 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await dispatchMorphCapability({
      capability: "apply",
      req: new Request("http://localhost/morphllm/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }),
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [{ email: "recover@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false, lastError: "401" }],
        roundRobinEnabled: false,
      },
    });

    await Promise.resolve();
    expect(atomicUpdateSettingsSpy).toHaveBeenCalledTimes(1);
  });

  it("fails over after an upstream timeout and records the timeout error", async () => {
    vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    const saveMorphUsageSpy = vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    vi.spyOn(localDb, "atomicUpdateSettings").mockImplementation(async (mutator) => mutator({ morph: { apiKeys: [] } }));
    const timeoutError = new Error("timed out");
    timeoutError.name = "AbortError";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, usage: { prompt_tokens: 2, completion_tokens: 3 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await dispatchMorphCapability({
      capability: "apply",
      req: new Request("http://localhost/morphllm/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }),
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [
          { email: "slow@example.com", key: "TEST_MORPH_KEY_SLOW", status: "active", isExhausted: false },
          { email: "fast@example.com", key: "TEST_MORPH_KEY_FAST", status: "active", isExhausted: false },
        ],
        roundRobinEnabled: false,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer TEST_MORPH_KEY_FAST");
    expect(response.status).toBe(200);
    expect(saveMorphUsageSpy).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "TEST_MORPH_KEY_FAST",
      apiKeyLabel: "fast@example.com",
      status: "ok",
    }), { propagateError: true });
  });

  it("surfaces a Morph timeout when all keys time out", async () => {
    vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    const saveMorphUsageSpy = vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    const timeoutError = new Error("timed out");
    timeoutError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw timeoutError;
    }));

    await expect(dispatchMorphCapability({
      capability: "apply",
      req: new Request("http://localhost/morphllm/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }),
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [{ email: "slow@example.com", key: "TEST_MORPH_KEY_SLOW", status: "active", isExhausted: false }],
        roundRobinEnabled: false,
      },
    })).rejects.toMatchObject({
      name: "AbortError",
      code: "MORPH_UPSTREAM_TIMEOUT",
      message: expect.stringContaining("timed out after"),
    });

    expect(saveMorphUsageSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: "error",
      apiKey: "TEST_MORPH_KEY_SLOW",
      error: expect.stringContaining("timed out after"),
    }), { propagateError: true });
  });

  it("does not buffer streaming success responses for usage extraction", async () => {
    vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    const saveMorphUsageSpy = vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    vi.spyOn(localDb, "atomicUpdateSettings").mockImplementation(async (mutator) => mutator({
      morph: {
        apiKeys: [{ email: "stream@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false, lastError: "" }],
      },
    }));
    const cloneTextSpy = vi.fn(async () => "should-not-be-read");
    const fetchResponse = new Response("data: hello\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    vi.spyOn(fetchResponse, "clone").mockReturnValue({ text: cloneTextSpy });
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse));

    const response = await dispatchMorphCapability({
      capability: "apply",
      req: new Request("http://localhost/morphllm/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "morph-v3-large", stream: true, messages: [] }),
      }),
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [{ email: "stream@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false }],
        roundRobinEnabled: false,
      },
    });

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(cloneTextSpy).not.toHaveBeenCalled();
    expect(saveMorphUsageSpy).toHaveBeenCalledWith(expect.objectContaining({
      tokens: {
        prompt_tokens: 0,
        completion_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      },
    }), { propagateError: true });
  });

  it("does not fail pass-through when usage body buffering cannot be decoded", async () => {
    vi.spyOn(usageDb, "trackPendingRequest").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saveMorphUsageSpy = vi.spyOn(morphUsageDb, "saveMorphUsage").mockResolvedValue(null);
    vi.spyOn(localDb, "atomicUpdateSettings").mockImplementation(async (mutator) => mutator({
      morph: {
        apiKeys: [{ email: "stable@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false, lastError: "" }],
      },
    }));

    const fetchResponse = new Response(JSON.stringify({ ok: true, usage: { prompt_tokens: 7, completion_tokens: 8 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    vi.spyOn(fetchResponse, "clone").mockReturnValue({
      text: vi.fn(async () => {
        throw new TypeError("Decompression failed");
      }),
    });
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse));

    const response = await dispatchMorphCapability({
      capability: "apply",
      req: new Request("http://localhost/morphllm/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "morph-v3-large", messages: [] }),
      }),
      morphSettings: {
        baseUrl: "https://api.morphllm.com/",
        apiKeys: [{ email: "stable@example.com", key: "TEST_MORPH_KEY_A", status: "active", isExhausted: false }],
        roundRobinEnabled: false,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, usage: { prompt_tokens: 7, completion_tokens: 8 } });
    expect(consoleWarnSpy).toHaveBeenCalledWith("[morph] Skipping usage body read:", expect.any(TypeError));
    expect(saveMorphUsageSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: "ok",
      tokens: {
        prompt_tokens: 0,
        completion_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      },
    }), { propagateError: true });
  });
});
