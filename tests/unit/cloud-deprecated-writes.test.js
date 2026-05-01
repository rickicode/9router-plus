import { describe, expect, it } from "vitest";

import { handleSync } from "../../cloud/src/handlers/sync.js";
import { handleSqliteBackupUpload } from "../../cloud/src/handlers/r2backup.js";
import { handleAdminRegister, handleAdminRuntimeRefresh, handleAdminStatusJson } from "../../cloud/src/handlers/admin.js";
import { saveMachineData } from "../../cloud/src/services/storage.js";

const TEST_WORKER_SHARED_VALUE = "test-shared-value";

function createEnv() {
  const store = new Map();

  return {
    CLOUD_SHARED_SECRET: TEST_WORKER_SHARED_VALUE,
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
      }
    }
  };
}

describe("deprecated worker-side write paths", () => {
  it("rejects sync POST writes with runtimeUrl guidance", async () => {
    const response = await handleSync(
      new Request("https://worker.example.com/sync/machine-1", { method: "POST" }),
      {},
      {}
    );
    const payload = await response.json();

    expect(response.status).toBe(410);
    expect(payload.error).toContain("Sync writes are deprecated");
    expect(payload.privateR2RuntimeRequired).toBe(true);
  });

  it("rejects worker-side SQLite backup uploads", async () => {
    const response = await handleSqliteBackupUpload(
      new Request("https://worker.example.com/r2/backup/sqlite/machine-1", { method: "POST" }),
      {}
    );
    const payload = await response.json();

    expect(response.status).toBe(410);
    expect(payload.error).toContain("deprecated");
    expect(payload.writer).toBe("9router-plus");
  });

  it("uses admin runtime refresh instead of sync writes for cache invalidation", async () => {
    const env = createEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/runtime.json")) {
        return new Response(JSON.stringify({
          generatedAt: "2026-05-01T00:00:00.000Z",
          credentialsGeneratedAt: "*************:34:56.000Z",
          runtimeConfigGeneratedAt: "2026-05-01T00:00:00.000Z",
          providers: {},
          modelAliases: {},
          combos: [],
          apiKeys: [],
          settings: {},
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (String(url).endsWith("/eligible.json")) {
        return new Response(JSON.stringify({ providers: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }

      return new Response("not found", { status: 404 });
    };

    try {
      await handleAdminRegister(new Request("https://worker.example.com/admin/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Cloud-Secret": TEST_WORKER_SHARED_VALUE,
        },
        body: JSON.stringify({
          runtimeUrl: "https://runtime.example.com/base",
        })
      }), env);

      const response = await handleAdminRuntimeRefresh(new Request("https://worker.example.com/admin/runtime/refresh", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Cloud-Secret": TEST_WORKER_SHARED_VALUE,
        },
        body: JSON.stringify({})
      }), env);
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ success: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports effective merged runtime state in admin status", async () => {
    const env = createEnv();

    await handleAdminRegister(new Request("https://worker.example.com/admin/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cloud-Secret": TEST_WORKER_SHARED_VALUE,
      },
      body: JSON.stringify({
        runtimeUrl: "https://runtime.example.com/base",
      })
    }), env);

    await saveMachineData("shared", {
      providers: {
        "conn-1": {
          id: "conn-1",
          provider: "anthropic",
          isActive: true,
          routingStatus: "blocked",
          quotaState: "exhausted",
          authState: "ok",
          healthStatus: "degraded",
          nextRetryAt: "2026-04-29T01:00:00.000Z",
        }
      },
      modelAliases: { smart: "anthropic/claude" },
      combos: [{ id: "combo-1", models: ["smart"] }],
      apiKeys: [{ key: "worker-placeholder-key", isActive: true }],
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
            "conn-1": {
              id: "conn-1",
              provider: "anthropic",
              isActive: true,
              routingStatus: "eligible",
              quotaState: "ok",
              authState: "ok",
              healthStatus: "healthy",
            }
          },
          modelAliases: { smart: "anthropic/claude" },
          combos: [{ id: "combo-1", models: ["smart"] }],
          apiKeys: [{ key: "worker-placeholder-key", isActive: true }],
          settings: {},
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (String(url).endsWith("/eligible.json")) {
        return new Response(JSON.stringify({
          providers: {
            "conn-1": {
              id: "conn-1",
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
      const response = await handleAdminStatusJson(new Request("https://worker.example.com/admin/status.json", {
        headers: { "X-Cloud-Secret": TEST_WORKER_SHARED_VALUE }
      }), env);
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.counts).toMatchObject({ providers: 1, modelAliases: 0, combos: 0, apiKeys: 0 });
      expect(payload.providers[0]).toMatchObject({
        id: "conn-1",
        routingStatus: "blocked",
        quotaState: "exhausted",
        healthStatus: "degraded",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
