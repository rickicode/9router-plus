import { describe, expect, it } from "vitest";

import {
  handleAdminRegister,
  handleAdminRuntimeRefresh,
  handleAdminStatusJson,
  handleAdminUnregister,
} from "../../cloud/src/handlers/admin.js";
import { getMachineData, saveMachineData } from "../../cloud/src/services/storage.js";

function createEnv() {
  const store = new Map();

  return {
    CLOUD_SHARED_SECRET: "super-secret-1234",
    R2_DATA: {
      async get(key) {
        if (!store.has(key)) return null;
        const value = store.get(key);
        return {
          async json() {
            return JSON.parse(value);
          }
        };
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      }
    }
  };
}

describe("cloud admin register runtime metadata", () => {
  it("returns 503 when the worker shared secret env is missing", async () => {
    const env = createEnv();
    env.CLOUD_SHARED_SECRET = "";

    const request = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({
        runtimeUrl: "https://runtime.example.com",
      })
    });

    const response = await handleAdminRegister(request, env);
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({ error: "Worker shared secret is not configured" });
  });

  it("stores runtimeUrl during registration and returns runtimeUrl", async () => {
    const env = createEnv();

    const request = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({
        runtimeUrl: "https://runtime.example.com",
        cacheTtlSeconds: 45,
      })
    });

    const response = await handleAdminRegister(request, env);
    const payload = await response.json();
    const stored = await getMachineData("shared", env);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      runtimeUrl: "https://runtime.example.com"
    });
    expect(stored.meta).toMatchObject({
      runtimeUrl: "https://runtime.example.com",
      cacheTtlSeconds: 45,
    });
  });

  it("rejects invalid cacheTtlSeconds", async () => {
    const env = createEnv();

    const request = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({
        runtimeUrl: "https://runtime.example.com",
        cacheTtlSeconds: 0,
      })
    });

    const response = await handleAdminRegister(request, env);
    const payload = await response.json();
    const stored = await env.R2_DATA.get("machines/shared.json");

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({ error: "Invalid cacheTtlSeconds" });
    expect(stored).toBeNull();
  });

  it("rejects non-https runtime URLs", async () => {
    const env = createEnv();

    const request = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({
        runtimeUrl: "http://runtime.example.com",
      })
    });

    const response = await handleAdminRegister(request, env);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({ error: "runtimeUrl must use HTTPS" });
  });

  it("preserves existing runtime metadata on re-register when omitted", async () => {
    const env = createEnv();

    const firstRequest = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({
        runtimeUrl: "https://runtime.example.com",
        cacheTtlSeconds: 30,
      })
    });

    await handleAdminRegister(firstRequest, env);

    const secondRequest = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({})
    });

    const response = await handleAdminRegister(secondRequest, env);
    const payload = await response.json();
    const stored = await getMachineData("shared", env);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      runtimeUrl: "https://runtime.example.com"
    });
    expect(stored.meta).toMatchObject({
      runtimeUrl: "https://runtime.example.com",
      cacheTtlSeconds: 30,
    });
  });

  it("persists runtime metadata when a shared record already exists", async () => {
    const env = createEnv();
    await env.R2_DATA.put("machines/shared.json", JSON.stringify({
      providers: {},
      modelAliases: {},
      combos: [],
      apiKeys: [],
      settings: {},
      meta: {}
    }));

    const request = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({
        runtimeUrl: "https://runtime.example.com",
      })
    });

    const response = await handleAdminRegister(request, env);
    const payload = await response.json();
    const stored = await getMachineData("shared", env);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      runtimeUrl: "https://runtime.example.com"
    });
    expect(stored.meta).toMatchObject({
      runtimeUrl: "https://runtime.example.com",
    });
  });

  it("rejects mismatched secret without overwriting runtime metadata", async () => {
    const env = createEnv();

    const firstRequest = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({
        runtimeUrl: "https://runtime.example.com",
      })
    });

    await handleAdminRegister(firstRequest, env);

    const secondRequest = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "wrong-secret-1234",
      },
      body: JSON.stringify({
        runtimeUrl: "https://evil.example.com",
      })
    });

    const response = await handleAdminRegister(secondRequest, env);
    const payload = await response.json();
    const stored = await getMachineData("shared", env);

    expect(response.status).toBe(401);
    expect(payload).toMatchObject({ error: "Unauthorized" });
    expect(stored.meta).toMatchObject({
      runtimeUrl: "https://runtime.example.com",
    });
  });

  it("refreshes runtime cache for an authorized worker", async () => {
    const env = createEnv();

    await handleAdminRegister(new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({
        runtimeUrl: "https://runtime.example.com",
      })
    }), env);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/runtime.json")) {
        return new Response(JSON.stringify({
          providers: {},
          modelAliases: {},
          combos: [],
          apiKeys: [],
          settings: {},
          generatedAt: "2026-04-29T00:00:00.000Z",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (String(url).endsWith("/eligible.json")) {
        return new Response(JSON.stringify({ providers: {} }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response("not found", { status: 404 });
    };

    try {
      const response = await handleAdminRuntimeRefresh(new Request("https://example.com/admin/runtime/refresh", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Cloud-Secret": "super-secret-1234",
        },
        body: JSON.stringify({})
      }), env);
      const payload = await response.json();
      const stored = await getMachineData("shared", env);

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ success: true });
      expect(stored.meta.runtimeRefreshRequestedAt).toEqual(expect.any(String));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects runtime refresh when secret is invalid", async () => {
    const env = createEnv();

    await handleAdminRegister(new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({
        runtimeUrl: "https://runtime.example.com",
      })
    }), env);

    const response = await handleAdminRuntimeRefresh(new Request("https://example.com/admin/runtime/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "wrong-secret-1234",
      },
      body: JSON.stringify({})
    }), env);
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload).toMatchObject({ error: "Unauthorized" });
  });

  it("deletes the shared record when unregister is authorized", async () => {
    const env = createEnv();

    await handleAdminRegister(new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({})
    }), env);

    const response = await handleAdminUnregister(new Request("https://example.com/admin/unregister", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({})
    }), env);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ success: true });
    expect(await getMachineData("shared", env)).toBeNull();
  });

  it("rejects unregister when secret is invalid", async () => {
    const env = createEnv();

    await handleAdminRegister(new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({})
    }), env);

    const response = await handleAdminUnregister(new Request("https://example.com/admin/unregister", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "wrong-secret-1234",
      },
      body: JSON.stringify({})
    }), env);
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload).toMatchObject({ error: "Unauthorized" });
    expect(await getMachineData("shared", env)).not.toBeNull();
  });

  it("reports effective merged runtime state from admin status", async () => {
    const env = createEnv();

    await handleAdminRegister(new Request("https://example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": "super-secret-1234",
      },
      body: JSON.stringify({
        runtimeUrl: "https://runtime.example.com/base",
      })
    }), env);

    await saveMachineData("shared", {
      providers: {
        conn1: {
          id: "conn1",
          routingStatus: "blocked",
          quotaState: "exhausted",
          healthStatus: "degraded",
          isActive: true,
        }
      },
      modelAliases: {},
      combos: [],
      apiKeys: [],
      settings: {},
      meta: {
        runtimeUrl: "https://runtime.example.com/base",
      }
    }, env);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/runtime.json")) {
        return new Response(JSON.stringify({
          providers: {
            conn1: {
              id: "conn1",
              provider: "anthropic",
              authType: "oauth",
              displayName: "Primary",
              isActive: true,
              routingStatus: "eligible",
              quotaState: "ok",
              healthStatus: "healthy",
            }
          },
          modelAliases: { smart: "anthropic/claude" },
          combos: [{ id: "combo-1", models: ["smart"] }],
          apiKeys: [{ key: "worker-key", isActive: true }],
          settings: {},
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (String(url).endsWith("/eligible.json")) {
        return new Response(JSON.stringify({
          providers: {
            conn1: {
              id: "conn1",
              provider: "anthropic",
              isActive: true,
              routingStatus: "eligible",
            }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      return new Response("not found", { status: 404 });
    };

    try {
      const response = await handleAdminStatusJson(new Request("https://example.com/admin/status.json", {
        headers: { "X-Cloud-Secret": "super-secret-1234" }
      }), env);
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.counts).toMatchObject({ providers: 1, modelAliases: 1, combos: 1, apiKeys: 1 });
      expect(payload.providers[0]).toMatchObject({
        id: "conn1",
        provider: "anthropic",
        routingStatus: "blocked",
        quotaState: "exhausted",
        healthStatus: "degraded",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
