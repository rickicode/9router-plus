import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { setChatRuntimeSettings } from "../../open-sse/utils/abort.js";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

describe("BaseExecutor upstream timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    setChatRuntimeSettings({});
    delete process.env.CHAT_UPSTREAM_TIMEOUT_MS;
    delete process.env.CHAT_COMPACT_UPSTREAM_TIMEOUT_MS;
  });

  it("passes a merged abort signal to upstream fetch", async () => {
    proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const executor = new BaseExecutor("openai-compatible-test", {
      baseUrl: "https://example.test/v1",
    });

    await executor.execute({
      model: "gpt-test",
      body: { messages: [] },
      stream: false,
      credentials: { apiKey: "test", providerSpecificData: { baseUrl: "https://example.test/v1" } },
    });

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://example.test/v1/chat/completions",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      null,
    );
  });

  it("converts deadline aborts into upstream timeout errors", async () => {
    process.env.CHAT_UPSTREAM_TIMEOUT_MS = "10";
    vi.useFakeTimers();
    proxyAwareFetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const executor = new BaseExecutor("openai-compatible-test", {
      baseUrl: "https://example.test/v1",
    });

    const request = executor.execute({
      model: "gpt-test",
      body: { messages: [] },
      stream: false,
      credentials: { apiKey: "test", providerSpecificData: { baseUrl: "https://example.test/v1" } },
    });
    request.catch(() => null);

    await vi.advanceTimersByTimeAsync(10);
    await expect(request).rejects.toMatchObject({
      name: "AbortError",
      code: "UPSTREAM_TIMEOUT",
    });
  });

  it("keeps the timeout active until a non-streaming body is consumed", async () => {
    process.env.CHAT_UPSTREAM_TIMEOUT_MS = "10";
    vi.useFakeTimers();
    proxyAwareFetch.mockResolvedValue(new Response(new ReadableStream({}), { status: 200 }));
    const executor = new BaseExecutor("openai-compatible-test", {
      baseUrl: "https://example.test/v1",
    });

    const { response } = await executor.execute({
      model: "gpt-test",
      body: { messages: [] },
      stream: false,
      credentials: { apiKey: "test", providerSpecificData: { baseUrl: "https://example.test/v1" } },
    });

    const bodyRead = response.json();
    bodyRead.catch(() => null);

    await vi.advanceTimersByTimeAsync(10);
    await expect(bodyRead).rejects.toMatchObject({
      name: "AbortError",
      code: "UPSTREAM_TIMEOUT",
    });
  });

  it("prefers executor-specific timeout overrides over the global timeout", async () => {
    process.env.CHAT_UPSTREAM_TIMEOUT_MS = "10";
    const executor = new BaseExecutor("openai-compatible-test", {
      baseUrl: "https://example.test/v1",
    });
    executor.getTimeoutMs = vi.fn(() => 123456);
    proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await executor.execute({
      model: "gpt-test",
      body: { messages: [] },
      stream: false,
      credentials: { apiKey: "test", providerSpecificData: { baseUrl: "https://example.test/v1" } },
    });

    expect(executor.getTimeoutMs).toHaveBeenCalled();
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://example.test/v1/chat/completions",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      null,
    );
  });

  it("uses the compact-specific runtime timeout for compact requests", async () => {
    setChatRuntimeSettings({ upstreamTimeoutMs: 1000, compactUpstreamTimeoutMs: 321000 });
    proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const executor = new BaseExecutor("openai-compatible-test", {
      baseUrl: "https://example.test/v1",
    });

    await executor.execute({
      model: "gpt-test",
      body: { messages: [], _compact: true },
      stream: false,
      credentials: { apiKey: "test", providerSpecificData: { baseUrl: "https://example.test/v1" } },
    });

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://example.test/v1/chat/completions",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      null,
    );
  });
});
