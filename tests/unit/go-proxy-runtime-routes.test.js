import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    }),
  },
}));

describe("go proxy runtime routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { resetGoProxyRuntimeState } = await import("../../src/lib/goProxyRuntime.js");
    resetGoProxyRuntimeState({
      enabled: false,
      running: false,
      status: "stopped",
      startedAt: null,
      lastError: null,
    });
  });

  it("GET /api/runtime/go-proxy returns current runtime status", async () => {
    const { setGoProxyRuntimeState } = await import("../../src/lib/goProxyRuntime.js");
    setGoProxyRuntimeState({
      enabled: true,
      running: true,
      status: "running",
      host: "127.0.0.1",
      port: 20221,
      pid: 12345,
    });

    const { GET } = await import("../../src/app/api/runtime/go-proxy/route.js");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: true,
      running: true,
      status: "running",
      host: "127.0.0.1",
      port: 20221,
      pid: 12345,
    });
  });

  it("POST /api/runtime/go-proxy/start starts runtime and returns updated status", async () => {
    const { POST } = await import("../../src/app/api/runtime/go-proxy/start/route.js");
    const response = await POST(new Request("http://localhost/api/runtime/go-proxy/start", {
      method: "POST",
      body: JSON.stringify({
        reason: "manual_api",
        host: "127.0.0.1",
        port: 20138,
        ninerouterBaseUrl: "http://127.0.0.1:20129",
        internalResolveToken: "resolve-token",
        internalReportToken: "report-token",
        credentialsFile: "/tmp/db.json",
      }),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: true,
      running: true,
      status: "running",
      host: "127.0.0.1",
      port: 20138,
      ninerouterBaseUrl: "http://127.0.0.1:20129",
      internalResolveToken: "resolve-token",
      internalReportToken: "report-token",
      credentialsFile: "/tmp/db.json",
    });
    expect(typeof response.body.startedAt).toBe("string");
  });

  it("POST /api/runtime/go-proxy/start returns verification failure without enabling runtime", async () => {
    const { POST } = await import("../../src/app/api/runtime/go-proxy/start/route.js");
    const response = await POST(new Request("http://localhost/api/runtime/go-proxy/start", {
      method: "POST",
      body: JSON.stringify({
        host: "127.0.0.1",
        port: 20138,
        ninerouterBaseUrl: "http://127.0.0.1:20129",
        internalResolveToken: "resolve-token",
        internalReportToken: "report-token",
        credentialsFile: "/tmp/db.json",
        verification: {
          ok: false,
          error: "runtime-manager unavailable",
        },
      }),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      error: "runtime-manager unavailable",
      runtime: expect.objectContaining({
        enabled: false,
        running: false,
        status: "stopped",
        lastError: "runtime-manager unavailable",
      }),
    });
  });

  it("POST /api/runtime/go-proxy/stop stops runtime and returns stopped status", async () => {
    const { setGoProxyRuntimeState } = await import("../../src/lib/goProxyRuntime.js");
    setGoProxyRuntimeState({
      enabled: true,
      running: true,
      status: "running",
      host: "127.0.0.1",
      port: 20138,
      pid: 4321,
      startedAt: "2026-04-23T00:00:00.000Z",
      lastExitCode: null,
    });

    const { POST } = await import("../../src/app/api/runtime/go-proxy/stop/route.js");
    const response = await POST();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: false,
      running: false,
      status: "stopped",
      host: "127.0.0.1",
      port: 20138,
      pid: null,
      startedAt: null,
      lastExitCode: 0,
    });
  });

  it("POST /api/runtime/go-proxy/restart restarts runtime and preserves runtime contract", async () => {
    const { setGoProxyRuntimeState } = await import("../../src/lib/goProxyRuntime.js");
    setGoProxyRuntimeState({
      enabled: true,
      running: true,
      status: "running",
      host: "127.0.0.1",
      port: 20138,
      ninerouterBaseUrl: "http://127.0.0.1:20129",
      internalResolveToken: "resolve-token",
      internalReportToken: "report-token",
      credentialsFile: "/tmp/db.json",
      startedAt: "2026-04-23T00:00:00.000Z",
    });

    const { POST } = await import("../../src/app/api/runtime/go-proxy/restart/route.js");
    const response = await POST();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: true,
      running: true,
      status: "running",
      host: "127.0.0.1",
      port: 20138,
      ninerouterBaseUrl: "http://127.0.0.1:20129",
      internalResolveToken: "resolve-token",
      internalReportToken: "report-token",
      credentialsFile: "/tmp/db.json",
    });
    expect(typeof response.body.startedAt).toBe("string");
    expect(response.body.startedAt).not.toBe("2026-04-23T00:00:00.000Z");
  });

  it("POST /api/runtime/go-proxy/restart rolls back when verification fails", async () => {
    const { setGoProxyRuntimeState } = await import("../../src/lib/goProxyRuntime.js");
    setGoProxyRuntimeState({
      enabled: true,
      running: true,
      status: "running",
      host: "127.0.0.1",
      port: 20138,
      ninerouterBaseUrl: "http://127.0.0.1:20129",
      internalResolveToken: "resolve-token",
      internalReportToken: "report-token",
      credentialsFile: "/tmp/db.json",
      startedAt: "2026-04-23T00:00:00.000Z",
    });

    const { POST } = await import("../../src/app/api/runtime/go-proxy/restart/route.js");
    const response = await POST(new Request("http://localhost/api/runtime/go-proxy/restart", {
      method: "POST",
      body: JSON.stringify({
        verification: {
          ok: false,
          error: "health check failed",
        },
      }),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      error: "health check failed",
      runtime: expect.objectContaining({
        enabled: true,
        running: true,
        status: "running",
        host: "127.0.0.1",
        port: 20138,
        startedAt: "2026-04-23T00:00:00.000Z",
        lastError: "health check failed",
      }),
    });
  });

  it("POST /api/runtime/go-proxy/port updates runtime port and keeps runtime stopped", async () => {
    const { setGoProxyRuntimeState } = await import("../../src/lib/goProxyRuntime.js");
    setGoProxyRuntimeState({
      enabled: false,
      running: false,
      status: "stopped",
      host: "127.0.0.1",
      port: 20138,
    });

    const { POST } = await import("../../src/app/api/runtime/go-proxy/port/route.js");
    const response = await POST(new Request("http://localhost/api/runtime/go-proxy/port", {
      method: "POST",
      body: JSON.stringify({ port: 20139 }),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: false,
      running: false,
      status: "stopped",
      host: "127.0.0.1",
      port: 20139,
    });
  });
});
