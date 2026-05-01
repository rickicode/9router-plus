import { describe, expect, it, vi } from "vitest";

const TEST_WORKER_SHARED_VALUE = "test-shared-value";

describe("cloudWorkerClient", () => {
  it("registerWithWorker sends runtimeUrl and cache metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, version: "0.3.0" }),
    });
    vi.stubGlobal("fetch", fetchImpl);

    const { registerWithWorker } = await import("@/lib/cloudWorkerClient.js");

    await registerWithWorker("https://worker.example.com/", TEST_WORKER_SHARED_VALUE, {
      runtimeUrl: "https://public.example.com/runtime",
      cacheTtlSeconds: 15,
    });

    const [, request] = fetchImpl.mock.calls[0];
    expect(JSON.parse(request.body)).toMatchObject({
      runtimeUrl: "https://public.example.com/runtime",
      cacheTtlSeconds: 15,
    });
  });

  it("refreshWorkerRuntime posts an empty body to the admin refresh endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, refreshedAt: "2026-04-29T00:00:00.000Z" }),
    });
    vi.stubGlobal("fetch", fetchImpl);

    const { refreshWorkerRuntime } = await import("@/lib/cloudWorkerClient.js");

    const result = await refreshWorkerRuntime("https://worker.example.com/", TEST_WORKER_SHARED_VALUE);

    expect(result).toEqual({ success: true, refreshedAt: "2026-04-29T00:00:00.000Z" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://worker.example.com/admin/runtime/refresh",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Cloud-Secret": TEST_WORKER_SHARED_VALUE,
        }),
        body: JSON.stringify({}),
      })
    );
  });

  it("unregisterWorker posts an empty body to the admin unregister endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", fetchImpl);

    const { unregisterWorker } = await import("@/lib/cloudWorkerClient.js");

    const result = await unregisterWorker("https://worker.example.com/", TEST_WORKER_SHARED_VALUE);

    expect(result).toEqual({ success: true });
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://worker.example.com/admin/unregister");
    expect(request.method).toBe("POST");
    expect(request.headers["Content-Type"] || request.headers.get?.("Content-Type")).toBe("application/json");
    expect(request.headers["X-Cloud-Secret"] || request.headers.get?.("X-Cloud-Secret")).toBe(TEST_WORKER_SHARED_VALUE);
    expect(request.body).toBe(JSON.stringify({}));
  });
});
