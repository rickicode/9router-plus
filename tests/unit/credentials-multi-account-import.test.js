import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConnections = [];
const createProviderConnection = vi.fn(async (data) => ({
  id: data.id || `created-${mockConnections.length + createProviderConnection.mock.calls.length}`,
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

describe("credentials import with multiple oauth accounts per provider", () => {
  beforeEach(() => {
    mockConnections.length = 0;
    createProviderConnection.mockClear();
    updateProviderConnection.mockClear();
    getProviderConnections.mockClear();
    getProviderConnections.mockResolvedValue(mockConnections);
  });

  it("updates two existing oauth accounts when import emails explicitly match", async () => {
    mockConnections.push(
      {
        id: "conn-primary",
        provider: "codex",
        authType: "oauth",
        email: "alpha@example.com",
        name: "Alpha",
        accessToken: "old-alpha-token",
      },
      {
        id: "conn-secondary",
        provider: "codex",
        authType: "oauth",
        email: "beta@example.com",
        name: "Beta",
        accessToken: "old-beta-token",
      },
    );

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");

    const response = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        entries: [
          {
            provider: "codex",
            authType: "oauth",
            email: "alpha@example.com",
            accessToken: "new-alpha-token",
          },
          {
            provider: "codex",
            authType: "oauth",
            email: "beta@example.com",
            accessToken: "new-beta-token",
          },
        ],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      created: 0,
      updated: 2,
      skipped: 0,
      imported: 2,
    });
    expect(updateProviderConnection).toHaveBeenCalledTimes(2);
    expect(updateProviderConnection).toHaveBeenNthCalledWith(
      1,
      "conn-primary",
      expect.objectContaining({
        provider: "codex",
        authType: "oauth",
        email: "alpha@example.com",
        accessToken: "new-alpha-token",
      }),
    );
    expect(updateProviderConnection).toHaveBeenNthCalledWith(
      2,
      "conn-secondary",
      expect.objectContaining({
        provider: "codex",
        authType: "oauth",
        email: "beta@example.com",
        accessToken: "new-beta-token",
      }),
    );
    expect(createProviderConnection).not.toHaveBeenCalled();
  });

  it("creates a new oauth connection when import has no email and multiple existing accounts are ambiguous", async () => {
    mockConnections.push(
      {
        id: "conn-primary",
        provider: "codex",
        authType: "oauth",
        email: "alpha@example.com",
        name: "Alpha",
        accessToken: "old-alpha-token",
      },
      {
        id: "conn-secondary",
        provider: "codex",
        authType: "oauth",
        email: "beta@example.com",
        name: "Beta",
        accessToken: "old-beta-token",
      },
    );

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");

    const response = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        entries: [
          {
            provider: "codex",
            authType: "oauth",
            accessToken: "brand-new-token",
            name: "Imported ambiguous account",
          },
        ],
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
      accessToken: "brand-new-token",
      name: "Imported ambiguous account",
    }));
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("updates the explicit email match and creates two new oauth accounts in a mixed import", async () => {
    mockConnections.push(
      {
        id: "conn-primary",
        provider: "codex",
        authType: "oauth",
        email: "alpha@example.com",
        name: "Alpha",
        accessToken: "old-alpha-token",
      },
      {
        id: "conn-secondary",
        provider: "codex",
        authType: "oauth",
        email: "beta@example.com",
        name: "Beta",
        accessToken: "old-beta-token",
      },
    );

    const { POST: importPOST } = await import("../../src/app/api/credentials/import/route.js");

    const response = await importPOST(new Request("http://localhost/api/credentials/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "universal-credentials",
        entries: [
          {
            provider: "codex",
            authType: "oauth",
            email: "alpha@example.com",
            accessToken: "updated-alpha-token",
          },
          {
            provider: "codex",
            authType: "oauth",
            accessToken: "new-without-email-1",
            name: "Imported account one",
          },
          {
            provider: "codex",
            authType: "oauth",
            accessToken: "new-without-email-2",
            name: "Imported account two",
          },
        ],
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      created: 2,
      updated: 1,
      skipped: 0,
      imported: 3,
    });
    expect(updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(updateProviderConnection).toHaveBeenCalledWith(
      "conn-primary",
      expect.objectContaining({
        provider: "codex",
        authType: "oauth",
        email: "alpha@example.com",
        accessToken: "updated-alpha-token",
      }),
    );
    expect(updateProviderConnection).not.toHaveBeenCalledWith(
      "conn-secondary",
      expect.anything(),
    );
    expect(createProviderConnection).toHaveBeenCalledTimes(2);
    expect(createProviderConnection).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: "codex",
        authType: "oauth",
        accessToken: "new-without-email-1",
        name: "Imported account one",
      }),
    );
    expect(createProviderConnection).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: "codex",
        authType: "oauth",
        accessToken: "new-without-email-2",
        name: "Imported account two",
      }),
    );
  });
});
