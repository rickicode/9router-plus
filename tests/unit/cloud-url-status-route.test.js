import { beforeEach, describe, expect, it, vi } from "vitest";

const getSettings = vi.fn();
const probeCloudHealth = vi.fn();
const fetchWorkerStatus = vi.fn();
const buildWorkerDashboardUrl = vi.fn();
const getConsistentMachineId = vi.fn();

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

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId,
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
      cloudUrls: [
        {
          id: "worker-1",
          url: "https://worker.example.com",
          name: "Primary Worker",
          secret: "secret-1234567890",
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
    getConsistentMachineId.mockResolvedValue("machine-123");

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
});
