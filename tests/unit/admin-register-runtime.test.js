import { describe, expect, it } from "vitest";

import { handleAdminRegister } from "../../cloud/src/handlers/admin.js";
import { getMachineData } from "../../cloud/src/services/storage.js";

function createEnv() {
  const store = new Map();

  return {
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

describe("cloud admin register runtime metadata", () => {
  it("stores runtimeUrl during registration and returns runtimeUrl", async () => {
    const env = createEnv();

    const request = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machineId: "machine-123",
        secret: "super-secret-1234",
        runtimeUrl: "https://runtime.example.com",
        cacheTtlSeconds: 45,
      })
    });

    const response = await handleAdminRegister(request, env);
    const payload = await response.json();
    const stored = await getMachineData("machine-123", env);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      runtimeUrl: "https://runtime.example.com"
    });
    expect(stored.meta).toMatchObject({
      secret: "super-secret-1234",
      runtimeUrl: "https://runtime.example.com",
      cacheTtlSeconds: 45,
    });
  });

  it("rejects invalid cacheTtlSeconds", async () => {
    const env = createEnv();

    const request = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machineId: "machine-bad-ttl",
        secret: "super-secret-1234",
        runtimeUrl: "https://runtime.example.com",
        cacheTtlSeconds: 0,
      })
    });

    const response = await handleAdminRegister(request, env);
    const payload = await response.json();
    const stored = await getMachineData("machine-bad-ttl", env);

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({ error: "Invalid cacheTtlSeconds" });
    expect(stored).toBeNull();
  });

  it("preserves existing runtime metadata on same-secret re-register when omitted", async () => {
    const env = createEnv();

    const firstRequest = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machineId: "machine-keep",
        secret: "super-secret-1234",
        runtimeUrl: "https://runtime.example.com",
        cacheTtlSeconds: 30,
      })
    });

    await handleAdminRegister(firstRequest, env);

    const secondRequest = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machineId: "machine-keep",
        secret: "super-secret-1234"
      })
    });

    const response = await handleAdminRegister(secondRequest, env);
    const payload = await response.json();
    const stored = await getMachineData("machine-keep", env);

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

  it("persists runtime metadata when claiming a legacy record", async () => {
    const env = createEnv();
    await env.R2_DATA.put("machines/machine-legacy.json", JSON.stringify({
      providers: {},
      modelAliases: {},
      combos: [],
      apiKeys: [],
      settings: {},
      meta: {}
    }));

    const request = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machineId: "machine-legacy",
        secret: "super-secret-1234",
        runtimeUrl: "https://runtime.example.com",
      })
    });

    const response = await handleAdminRegister(request, env);
    const payload = await response.json();
    const stored = await getMachineData("machine-legacy", env);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      claimedLegacy: true,
      runtimeUrl: "https://runtime.example.com"
    });
    expect(stored.meta).toMatchObject({
      claimedLegacy: true,
      secret: "super-secret-1234",
      runtimeUrl: "https://runtime.example.com",
    });
  });

  it("rejects mismatched secret without overwriting runtime metadata", async () => {
    const env = createEnv();

    const firstRequest = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machineId: "machine-locked",
        secret: "super-secret-1234",
        runtimeUrl: "https://runtime.example.com",
      })
    });

    await handleAdminRegister(firstRequest, env);

    const secondRequest = new Request("https://example.com/admin/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machineId: "machine-locked",
        secret: "wrong-secret-1234",
        runtimeUrl: "https://evil.example.com",
      })
    });

    const response = await handleAdminRegister(secondRequest, env);
    const payload = await response.json();
    const stored = await getMachineData("machine-locked", env);

    expect(response.status).toBe(401);
    expect(payload).toMatchObject({ error: "Secret mismatch — machine already registered" });
    expect(stored.meta).toMatchObject({
      runtimeUrl: "https://runtime.example.com",
    });
  });
});
