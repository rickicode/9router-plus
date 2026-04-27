import { describe, expect, it, vi } from "vitest";

describe("cloudWorkerClient", () => {
  it("registerWithWorker sends runtimeUrl and routing metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, version: "0.3.0" }),
    });
    vi.stubGlobal("fetch", fetchImpl);

    const { registerWithWorker } = await import("@/lib/cloudWorkerClient.js");

    await registerWithWorker("https://worker.example.com/", "secret-1234567890", "machine-1", {
      runtimeUrl: "https://public.example.com/machines/machine-1",
      routingConfig: { roundRobin: true, stickySessions: false },
      cacheTtlSeconds: 15,
    });

    const [, request] = fetchImpl.mock.calls[0];
    expect(JSON.parse(request.body)).toEqual({
      machineId: "machine-1",
      secret: "secret-1234567890",
      runtimeUrl: "https://public.example.com/machines/machine-1",
      routingConfig: { roundRobin: true, stickySessions: false },
      cacheTtlSeconds: 15,
    });
  });
});
