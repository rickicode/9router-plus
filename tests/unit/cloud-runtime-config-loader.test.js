import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeConfigLoader,
  isValidRuntimeConfig
} from "../../cloud/src/services/runtimeConfig.js";
import {
  getRuntimeConfig,
  getRuntimeRegistration
} from "../../cloud/src/services/storage.js";

function createEnv(machineDataById) {
  return {
    R2_DATA: {
      async get(key) {
        const match = key.match(/^machines\/(.+)\.json$/);
        const machineId = match?.[1];
        if (!machineId || !(machineId in machineDataById)) {
          return null;
        }

        return {
          async json() {
            return machineDataById[machineId];
          }
        };
      }
    }
  };
}

function createValidRuntimeConfig(overrides = {}) {
  return {
    providers: {},
    modelAliases: {},
    combos: [],
    apiKeys: [],
    settings: {},
    ...overrides
  };
}

describe("runtime config loader", () => {
  it("fetches runtime.json and caches it until ttl expires", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(createValidRuntimeConfig({ settings: { version: 1 } })), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    let nowMs = 10_000;
    const loader = createRuntimeConfigLoader({
      fetchImpl,
      now: () => nowMs
    });

    const registration = {
      runtimeUrl: "https://runtime.example.com/base",
      cacheTtlMs: 15_000
    };

    const first = await loader.load("machine-1", registration);
    nowMs += 5_000;
    const second = await loader.load("machine-1", registration);

    expect(first.settings.version).toBe(1);
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://runtime.example.com/base/runtime.json");
  });

  it("returns stale cached config on transient fetch failure after ttl expiry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(createValidRuntimeConfig({ settings: { version: 1 } })), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(new Response("upstream down", { status: 503 }));

    let nowMs = 20_000;
    const loader = createRuntimeConfigLoader({
      fetchImpl,
      now: () => nowMs
    });

    const registration = {
      runtimeUrl: "https://runtime.example.com/base",
      cacheTtlMs: 1_000
    };

    const fresh = await loader.load("machine-2", registration);
    nowMs += 1_500;
    const stale = await loader.load("machine-2", registration);

    expect(stale).toEqual(fresh);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws when transient fetch failure happens before any successful load", async () => {
    const loader = createRuntimeConfigLoader({
      fetchImpl: vi.fn(async () => {
        throw new Error("network down");
      })
    });

    await expect(
      loader.load("machine-3", { runtimeUrl: "https://runtime.example.com/base" })
    ).rejects.toThrow(/network down/i);
  });

  it("treats malformed payloads as unavailable and does not fall back to stale", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(createValidRuntimeConfig({ settings: { version: 1 } })), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ providers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    let nowMs = 30_000;
    const loader = createRuntimeConfigLoader({
      fetchImpl,
      now: () => nowMs
    });

    const registration = {
      runtimeUrl: "https://runtime.example.com/base",
      cacheTtlMs: 1_000
    };

    await loader.load("machine-4", registration);
    nowMs += 1_500;

    await expect(loader.load("machine-4", registration)).rejects.toThrow(/invalid runtime config/i);
  });

  it("reads registration metadata from storage and fetches runtime config", async () => {
    const env = createEnv({
      "machine-5": {
        providers: {},
        modelAliases: {},
        combos: [],
        apiKeys: [],
        settings: {},
        meta: {
          runtimeUrl: "https://runtime.example.com/base",
          cacheTtlSeconds: 1
        }
      }
    });

    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(createValidRuntimeConfig({ settings: { source: "remote" } })), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const registration = await getRuntimeRegistration("machine-5", env);
    const config = await getRuntimeConfig("machine-5", env, {
      runtimeConfigLoader: createRuntimeConfigLoader({ fetchImpl })
    });

    expect(registration).toEqual({
      runtimeUrl: "https://runtime.example.com/base",
      cacheTtlMs: 1_000
    });
    expect(config.settings.source).toBe("remote");
  });

  it("prefers spec cacheTtlSeconds over legacy cacheTtlMs when both exist", async () => {
    const env = createEnv({
      "machine-6": {
        providers: {},
        modelAliases: {},
        combos: [],
        apiKeys: [],
        settings: {},
        meta: {
          runtimeUrl: "https://runtime.example.com/base",
          cacheTtlSeconds: 2,
          cacheTtlMs: 99
        }
      }
    });

    const registration = await getRuntimeRegistration("machine-6", env);

    expect(registration).toEqual({
      runtimeUrl: "https://runtime.example.com/base",
      cacheTtlMs: 2_000
    });
  });

  it("fetches from new runtimeUrl when registration changes instead of returning stale cache", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(createValidRuntimeConfig({ settings: { source: "old-url" } })), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(createValidRuntimeConfig({ settings: { source: "new-url" } })), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );

    let nowMs = 40_000;
    const loader = createRuntimeConfigLoader({
      fetchImpl,
      now: () => nowMs
    });

    const oldRegistration = {
      runtimeUrl: "https://old.example.com/base",
      cacheTtlMs: 10_000
    };

    const newRegistration = {
      runtimeUrl: "https://new.example.com/base",
      cacheTtlMs: 10_000
    };

    const oldConfig = await loader.load("machine-7", oldRegistration);
    nowMs += 2_000;
    const newConfig = await loader.load("machine-7", newRegistration);

    expect(oldConfig.settings.source).toBe("old-url");
    expect(newConfig.settings.source).toBe("new-url");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://old.example.com/base/runtime.json");
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://new.example.com/base/runtime.json");
  });
});

describe("isValidRuntimeConfig", () => {
  it("requires the minimum runtime config shape", () => {
    expect(isValidRuntimeConfig(createValidRuntimeConfig())).toBe(true);
    expect(isValidRuntimeConfig(null)).toBe(false);
    expect(isValidRuntimeConfig({})).toBe(false);
    expect(isValidRuntimeConfig(createValidRuntimeConfig({ providers: [] }))).toBe(false);
    expect(isValidRuntimeConfig(createValidRuntimeConfig({ combos: {} }))).toBe(false);
    expect(isValidRuntimeConfig(createValidRuntimeConfig({ apiKeys: {} }))).toBe(false);
  });
});
