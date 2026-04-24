import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConnections = [];
const createProviderConnection = vi.fn(async (data) => ({
  id: data.id || `created-${mockConnections.length + 1}`,
  ...data,
}));
const updateProviderConnection = vi.fn(async (id, data) => ({ id, ...data }));
const getProviderConnections = vi.fn(async () => mockConnections);

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/localDb", () => ({
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
}));

const LEGACY_FIELDS = [
  "testStatus",
  "lastTested",
  "lastError",
  "lastErrorType",
  "lastErrorAt",
  "rateLimitedUntil",
  "errorCode",
];

describe("credentials import/export canonical transport", () => {
  beforeEach(() => {
    mockConnections.length = 0;
    createProviderConnection.mockClear();
    updateProviderConnection.mockClear();
    getProviderConnections.mockClear();
    getProviderConnections.mockResolvedValue(mockConnections);
  });

  it("exports canonical-only status fields and excludes legacy mirrors", async () => {
    mockConnections.push({
      id: "conn-1",
      provider: "codex",
      authType: "oauth",
      name: "Account 1",
      accessToken: "access-token",
      authState: "expired",
      healthStatus: "healthy",
      quotaState: "cooldown",
      routingStatus: "exhausted",
      nextRetryAt: "2026-04-20T10:00:00.000Z",
      resetAt: "2026-04-20T11:00:00.000Z",
      testStatus: "error",
      lastErrorType: "token_expired",
      lastError: "Token expired",
    });

    const { GET: exportGET } = await import("../../src/app/api/credentials/export/route.js");
    const exportResponse = await exportGET();

    expect(exportResponse.status).toBe(200);
    expect(exportResponse.body.entries).toHaveLength(1);
    const [entry] = exportResponse.body.entries;

    expect(entry).toMatchObject({
      authState: "expired",
      healthStatus: "healthy",
      quotaState: "cooldown",
      routingStatus: "exhausted",
      nextRetryAt: "2026-04-20T10:00:00.000Z",
      resetAt: "2026-04-20T11:00:00.000Z",
    });

    for (const field of LEGACY_FIELDS) {
      expect(entry).not.toHaveProperty(field);
    }
  });

  it("strips legacy status fields and imports successfully", async () => {
    getProviderConnections.mockResolvedValue([]);

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");

    const response = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        entries: [{
          provider: "codex",
          authType: "oauth",
          accessToken: "legacy-access",
          testStatus: "unavailable",
        }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      created: 1,
      updated: 0,
      imported: 1,
    });
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
    const callArg = createProviderConnection.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("testStatus");
    expect(callArg).toMatchObject({
      provider: "codex",
      authType: "oauth",
      accessToken: "legacy-access",
    });
  });

  it("strips snake_case legacy status fields and imports successfully", async () => {
    getProviderConnections.mockResolvedValue([]);

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");

    const response = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        entries: [{
          provider: "codex",
          authType: "oauth",
          accessToken: "legacy-access",
          test_status: "unavailable",
          last_error_at: "2026-04-23T00:00:00.000Z",
        }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      created: 1,
      updated: 0,
      imported: 1,
    });
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
    const callArg = createProviderConnection.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("test_status");
    expect(callArg).not.toHaveProperty("last_error_at");
    expect(callArg).toMatchObject({
      provider: "codex",
      authType: "oauth",
      accessToken: "legacy-access",
    });
  });

  it("strips lastErrorAt legacy status field and imports successfully", async () => {
    getProviderConnections.mockResolvedValue([]);

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");

    const response = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        entries: [{
          provider: "codex",
          authType: "oauth",
          accessToken: "legacy-access",
          lastErrorAt: "2026-04-23T00:00:00.000Z",
        }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      created: 1,
      updated: 0,
      imported: 1,
    });
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
    const callArg = createProviderConnection.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("lastErrorAt");
    expect(callArg).toMatchObject({
      provider: "codex",
      authType: "oauth",
      accessToken: "legacy-access",
    });
  });

  it("strips legacy fields from mixed canonical and legacy status payloads", async () => {
    getProviderConnections.mockResolvedValue([]);

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");

    const response = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        entries: [{
          provider: "codex",
          authType: "oauth",
          accessToken: "access",
          routingStatus: "eligible",
          quotaState: "ok",
          authState: "ok",
          healthStatus: "healthy",
          testStatus: "active",
        }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      created: 1,
      updated: 0,
      imported: 1,
    });
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
    const callArg = createProviderConnection.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("testStatus");
    expect(callArg).toMatchObject({
      provider: "codex",
      authType: "oauth",
      accessToken: "access",
      routingStatus: "eligible",
      quotaState: "ok",
      authState: "ok",
      healthStatus: "healthy",
    });
  });

  it("imports canonical-only payloads successfully", async () => {
    getProviderConnections.mockResolvedValue([]);

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");

    const response = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        entries: [{
          provider: "codex",
          authType: "oauth",
          accessToken: "canonical-access",
          routingStatus: "eligible",
          quotaState: "ok",
          authState: "ok",
          healthStatus: "healthy",
          reasonCode: "unknown",
        }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      created: 1,
      updated: 0,
      skipped: 0,
      imported: 1,
    });
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
    expect(createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      authType: "oauth",
      accessToken: "canonical-access",
      routingStatus: "eligible",
      quotaState: "ok",
      authState: "ok",
      healthStatus: "healthy",
      reasonCode: "unknown",
    }));
  });

  it("skips records with missing provider and reports the reason", async () => {
    getProviderConnections.mockResolvedValue([]);

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");

    const response = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        entries: [{
          authType: "oauth",
          accessToken: "missing-provider-access",
        }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      created: 0,
      updated: 0,
      skipped: 1,
      imported: 0,
      skipReasons: [{
        code: "INVALID_RECORD",
        message: "Credential record is missing provider",
      }],
    });
    expect(createProviderConnection).not.toHaveBeenCalled();
  });

  it("skips records with no credential payload and reports the reason", async () => {
    getProviderConnections.mockResolvedValue([]);

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");

    const response = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        entries: [{
          provider: "codex",
          authType: "oauth",
        }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      created: 0,
      updated: 0,
      skipped: 1,
      imported: 0,
      skipReasons: [{
        code: "INVALID_RECORD",
        message: "Credential record has no credential payload",
      }],
    });
    expect(createProviderConnection).not.toHaveBeenCalled();
  });

  it("skips records with invalid authType and reports the reason", async () => {
    getProviderConnections.mockResolvedValue([]);

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");

    const response = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        entries: [{
          provider: "codex",
          authType: "bearer",
          accessToken: "token",
        }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      created: 0,
      updated: 0,
      skipped: 1,
      imported: 0,
      skipReasons: [{
        code: "INVALID_RECORD",
        message: 'Unsupported authType: bearer',
      }],
    });
    expect(createProviderConnection).not.toHaveBeenCalled();
  });
});
