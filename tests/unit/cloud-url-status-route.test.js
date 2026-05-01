import { beforeEach, describe, expect, it, vi } from "vitest";

const getSettings = vi.fn();
const probeCloudHealth = vi.fn();
const fetchWorkerStatus = vi.fn();
const buildWorkerDashboardUrl = vi.fn();

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings,
}));

vi.mock("@/lib/cloudWorkerClient", () => ({
  probeCloudHealth,
  fetchWorkerStatus,
  buildWorkerDashboardUrl,
}));

let GET;

function makeRequest(url, headers = {}) {
  return new Request(url, { headers });
}

describe("/api/cloud-urls/[id]/status", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "development";

    getSettings.mockResolvedValue({
      cloudSharedSecret: "secret-1234567890",
      cloudUrls: [
        {
          id: "worker-1",
          url: "https://worker.example.com",
          name: "Primary Worker",
          lastSyncAt: "2026-04-26T10:00:00.000Z",
          lastSyncOk: true,
          lastSyncError: null,
          providersCount: 2,
        },
      ],
    });
    probeCloudHealth.mockResolvedValue({ ok: true, latencyMs: 42 });
    fetchWorkerStatus.mockResolvedValue({
      lastSyncAt: "2026-04-26T10:05:00.000Z",
      counts: { providers: 3 },
    });
    buildWorkerDashboardUrl.mockReturnValue("https://worker.example.com/admin/status?token=abc");

    const mod = await import("../../src/app/api/cloud-urls/[id]/status/route.js");
    GET = mod.GET;
  });

  it("returns masked secret by default without exposing the raw secret", async () => {
    const response = await GET(
      makeRequest("http://localhost/api/cloud-urls/worker-1/status", {
        origin: "http://localhost",
        host: "localhost",
      }),
      { params: Promise.resolve({ id: "worker-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.body.hasSecret).toBe(true);
    expect(response.body.secretMasked).toBe("secret...7890");
    expect(response.body.secret).toBeUndefined();
    expect(response.body.dashboardUrl).toBe("https://worker.example.com/admin/status?token=abc");
  });

  it("returns the raw secret only when includeSecret=1", async () => {
    const response = await GET(
      makeRequest("http://localhost/api/cloud-urls/worker-1/status?includeSecret=1", {
        origin: "http://localhost",
        host: "localhost",
      }),
      { params: Promise.resolve({ id: "worker-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.body.secret).toBe("secret-1234567890");
    expect(response.body.secretMasked).toBe("secret...7890");
  });

  it("rejects cross-origin requests", async () => {
    const response = await GET(
      makeRequest("http://localhost/api/cloud-urls/worker-1/status?includeSecret=1", {
        origin: "http://evil.example.com",
        host: "localhost",
      }),
      { params: Promise.resolve({ id: "worker-1" }) }
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "CSRF validation failed" });
    expect(getSettings).not.toHaveBeenCalled();
  });

  it("rejects explicit cross-origin origins even if ajax headers are present", async () => {
    const response = await GET(
      makeRequest("http://localhost:20128/api/cloud-urls/worker-1/status?includeSecret=1", {
        origin: "http://evil.example.com",
        "sec-fetch-site": "cross-site",
        "x-requested-with": "XMLHttpRequest",
      }),
      { params: Promise.resolve({ id: "worker-1" }) }
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "CSRF validation failed" });
  });

  it("accepts same-loopback requests when browser uses 127.0.0.1 instead of localhost", async () => {
    const response = await GET(
      makeRequest("http://localhost:20128/api/cloud-urls/worker-1/status?includeSecret=1", {
        origin: "http://127.0.0.1:20128",
      }),
      { params: Promise.resolve({ id: "worker-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.body.secret).toBe("secret-1234567890");
  });

  it("accepts same-loopback requests via referer when origin header is absent", async () => {
    const response = await GET(
      makeRequest("http://localhost:20128/api/cloud-urls/worker-1/status?includeSecret=1", {
        referer: "http://127.0.0.1:20128/dashboard",
      }),
      { params: Promise.resolve({ id: "worker-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.body.secret).toBe("secret-1234567890");
  });


  it("accepts same-origin browser fetch hints when origin and referer are stripped", async () => {
    const response = await GET(
      makeRequest("http://localhost:20128/api/cloud-urls/worker-1/status?includeSecret=1", {
        "sec-fetch-site": "same-origin",
      }),
      { params: Promise.resolve({ id: "worker-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.body.secret).toBe("secret-1234567890");
  });

  it("accepts same-app ajax requests when browser omits origin metadata", async () => {
    const response = await GET(
      makeRequest("http://localhost:20128/api/cloud-urls/worker-1/status?includeSecret=1", {
        "x-requested-with": "XMLHttpRequest",
      }),
      { params: Promise.resolve({ id: "worker-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.body.secret).toBe("secret-1234567890");
  });

  it("accepts localhost requests even when browser omits all origin metadata in development", async () => {
    const response = await GET(
      makeRequest("http://localhost:20128/api/cloud-urls/worker-1/status?includeSecret=1"),
      { params: Promise.resolve({ id: "worker-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.body.secret).toBe("secret-1234567890");
  });

  it("accepts browser same-origin hints even when origin does not match the internal request URL", async () => {
    const response = await GET(
      makeRequest("http://127.0.0.1:20128/api/cloud-urls/worker-1/status?includeSecret=1", {
        origin: "http://localhost:20128",
        referer: "http://localhost:20128/dashboard/endpoint?tab=cloud",
        "sec-fetch-site": "same-origin",
        "x-requested-with": "XMLHttpRequest",
      }),
      { params: Promise.resolve({ id: "worker-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.body.secret).toBe("secret-1234567890");
  });

  it("accepts forwarded localhost origins when the internal request URL uses a different host", async () => {
    const response = await GET(
      makeRequest("http://0.0.0.0:20128/api/cloud-urls/worker-1/status?includeSecret=1", {
        origin: "http://localhost:20128",
        referer: "http://localhost:20128/dashboard/endpoint?tab=cloud",
        host: "0.0.0.0:20128",
        "x-forwarded-host": "localhost:20128",
        "x-forwarded-proto": "http",
        "sec-fetch-site": "same-origin",
      }),
      { params: Promise.resolve({ id: "worker-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.body.secret).toBe("secret-1234567890");
  });
});
