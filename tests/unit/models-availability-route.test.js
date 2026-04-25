import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConnections = [];
const getProviderConnections = vi.fn(async (filter = {}) => {
  if (filter?.provider) {
    return mockConnections.filter((connection) => connection.provider === filter.provider);
  }
  return mockConnections;
});
const updateProviderConnection = vi.fn(async (id, data) => ({ id, ...data }));

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
  getProviderConnections,
  updateProviderConnection,
}));

vi.mock("@/lib/connectionStatus", async () => {
  const actual = await import("../../src/lib/connectionStatus.js");
  return actual;
});

describe("models availability route", () => {
  const futureIso = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    mockConnections.length = 0;
    getProviderConnections.mockClear();
    updateProviderConnection.mockClear();
    vi.resetModules();
  });

  it("derives canonical provider-wide and model-lock rows from centralized state", async () => {
    const retryAt = futureIso();
    mockConnections.push(
      {
        id: "conn-cooldown",
        provider: "codex",
        name: "Cooldown Conn",
        routingStatus: "exhausted",
        nextRetryAt: retryAt,
        reasonDetail: "Quota exhausted",
      },
      {
        id: "conn-model-lock",
        provider: "codex",
        name: "Model Lock Conn",
        routingStatus: "eligible",
        ["modelLock_gpt-4.1"]: futureIso(),
      },
      {
        id: "conn-blocked",
        provider: "openai",
        name: "Blocked Conn",
        routingStatus: "blocked",
        lastError: "Probe failed",
      },
    );

    const { GET } = await import("../../src/app/api/models/availability/route.js");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.models).toEqual([
      expect.objectContaining({
        connectionId: "conn-cooldown",
        provider: "codex",
        model: "__all",
        status: "exhausted",
        until: retryAt,
        lastError: "Quota exhausted",
      }),
      expect.objectContaining({
        connectionId: "conn-model-lock",
        provider: "codex",
        model: "gpt-4.1",
        status: "cooldown",
      }),
      expect.objectContaining({
        connectionId: "conn-blocked",
        provider: "openai",
        connectionName: "Blocked Conn",
        model: "__all",
        status: "blocked",
        until: undefined,
        lastError: null,
      }),
    ]);
    expect(response.body.unavailableCount).toBe(3);
  });

  it("includes exhausted provider-wide and model-lock rows when both apply", async () => {
    const retryAt = futureIso();
    mockConnections.push({
      id: "conn-both",
      provider: "codex",
      name: "Mixed Conn",
      routingStatus: "exhausted",
      nextRetryAt: retryAt,
      modelLock_gpt4: futureIso(),
    });

    const { GET } = await import("../../src/app/api/models/availability/route.js");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.models).toEqual([
      expect.objectContaining({
        connectionId: "conn-both",
        model: "__all",
        status: "exhausted",
        until: retryAt,
      }),
      expect.objectContaining({
        connectionId: "conn-both",
        model: "gpt4",
        status: "cooldown",
      }),
    ]);
  });

  it("clears provider-wide cooldown fields without forced reactivation when status is not eligible", async () => {
    mockConnections.push({
      id: "conn-cooldown",
      provider: "codex",
      routingStatus: "exhausted",
      quotaState: "exhausted",
      testStatus: "unavailable",
      nextRetryAt: "2026-04-25T00:00:00.000Z",
      rateLimitedUntil: "2026-04-25T00:00:00.000Z",
      reasonCode: "quota_exhausted",
      reasonDetail: "Weekly quota exhausted",
      modelLock_gpt4: "2026-04-24T00:00:00.000Z",
    });

    const { POST } = await import("../../src/app/api/models/availability/route.js");
    const response = await POST(new Request("http://localhost/api/models/availability", {
      method: "POST",
      body: JSON.stringify({ action: "clearCooldown", provider: "codex", model: "__all" }),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(200);
    expect(updateProviderConnection).toHaveBeenCalledWith("conn-cooldown", {
      nextRetryAt: null,
      resetAt: null,
      modelLock_gpt4: null,
      routingStatus: null,
      quotaState: null,
    });
  });

  it("does not reactivate provider-wide clears when a non-cooldown blocker remains", async () => {
    mockConnections.push({
      id: "conn-expired",
      provider: "codex",
      routingStatus: "blocked_quota",
      quotaState: "exhausted",
      authState: "expired",
      testStatus: "unavailable",
      nextRetryAt: "2026-04-25T00:00:00.000Z",
    });

    const { POST } = await import("../../src/app/api/models/availability/route.js");
    const response = await POST(new Request("http://localhost/api/models/availability", {
      method: "POST",
      body: JSON.stringify({ action: "clearCooldown", provider: "codex", model: "__all" }),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(200);
    expect(updateProviderConnection).toHaveBeenCalledWith("conn-expired", {
      nextRetryAt: null,
      resetAt: null,
      quotaState: null,
    });
  });

  it("clears model-specific locks without forcing unrelated active connections", async () => {
    mockConnections.push({
      id: "conn-model-lock",
      provider: "codex",
      routingStatus: "eligible",
      testStatus: "active",
      modelLock_gpt4: "2026-04-24T00:00:00.000Z",
    });

    const { POST } = await import("../../src/app/api/models/availability/route.js");
    const response = await POST(new Request("http://localhost/api/models/availability", {
      method: "POST",
      body: JSON.stringify({ action: "clearCooldown", provider: "codex", model: "gpt4" }),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(200);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("ignores expired raw model lock fields when clearing a specific model", async () => {
    mockConnections.push({
      id: "conn-expired-lock",
      provider: "codex",
      routingStatus: "eligible",
      testStatus: "active",
      modelLock_gpt4: "2020-04-24T00:00:00.000Z",
    });

    const { POST } = await import("../../src/app/api/models/availability/route.js");
    const response = await POST(new Request("http://localhost/api/models/availability", {
      method: "POST",
      body: JSON.stringify({ action: "clearCooldown", provider: "codex", model: "gpt4" }),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(200);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});
