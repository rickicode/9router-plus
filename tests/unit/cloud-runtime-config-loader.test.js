import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeConfigLoader,
	isValidRuntimeConfig,
} from "../../cloud/src/services/runtimeConfig.js";
import {
	getRuntimeConfig,
	getRuntimeRegistration,
	invalidateRuntimeConfig,
} from "../../cloud/src/services/storage.js";

function createValidRuntimeConfig(overrides = {}) {
	return {
		providers: {},
		modelAliases: {},
		combos: [],
		apiKeys: [],
		settings: {},
		...overrides,
	};
}

describe("runtime config loader", () => {
	it("fetches runtime.json and caches it until ttl expires", async () => {
		const fetchImpl = vi.fn(async (url) => {
			if (String(url).endsWith("/eligible.json")) {
				return new Response(
					JSON.stringify({ providers: { eligible: { id: "eligible" } } }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}

			return new Response(
				JSON.stringify(createValidRuntimeConfig({ settings: { version: 1 } })),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});

		let nowMs = 10_000;
		const loader = createRuntimeConfigLoader({
			fetchImpl,
			now: () => nowMs,
		});

		const registration = {
			runtimeUrl: "https://runtime.example.com/base",
			cacheTtlMs: 15_000,
		};

		const first = await loader.load("machine-1", registration);
		nowMs += 5_000;
		const second = await loader.load("machine-1", registration);

		expect(first.settings.version).toBe(1);
		expect(first.providers).toEqual({ eligible: { id: "eligible" } });
		expect(second).toEqual(first);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			"https://runtime.example.com/base/runtime.json",
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			"https://runtime.example.com/base/eligible.json",
		);
	});

	it("falls back to runtime providers when eligible artifact is missing", async () => {
		const fetchImpl = vi.fn(async (url) => {
			if (String(url).endsWith("/eligible.json")) {
				return new Response("missing", { status: 404 });
			}

			return new Response(
				JSON.stringify(
					createValidRuntimeConfig({
						providers: { runtime: { id: "runtime" } },
					}),
				),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});

		const loader = createRuntimeConfigLoader({ fetchImpl });
		const config = await loader.load("machine-fallback", {
			runtimeUrl: "https://runtime.example.com/base",
		});

		expect(config.providers).toEqual({ runtime: { id: "runtime" } });
	});

	it("returns stale cached config on transient fetch failure after ttl expiry", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify(createValidRuntimeConfig({ settings: { version: 1 } })),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ providers: { eligible: { id: "eligible-1" } } }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(new Response("upstream down", { status: 503 }));

		let nowMs = 20_000;
		const loader = createRuntimeConfigLoader({
			fetchImpl,
			now: () => nowMs,
		});
		const registration = {
			runtimeUrl: "https://runtime.example.com/base",
			cacheTtlMs: 1_000,
		};

		const fresh = await loader.load("machine-2", registration);
		nowMs += 1_500;
		const stale = await loader.load("machine-2", registration);

		expect(stale).toEqual(fresh);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("throws when transient fetch failure happens before any successful load", async () => {
		const loader = createRuntimeConfigLoader({
			fetchImpl: vi.fn(async () => {
				throw new Error("network down");
			}),
		});

		await expect(
			loader.load("machine-3", {
				runtimeUrl: "https://runtime.example.com/base",
			}),
		).rejects.toThrow(/network down/i);
	});

	it("treats malformed payloads as unavailable and does not fall back to stale", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("{bad json", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ providers: { eligible: { id: "eligible" } } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(createValidRuntimeConfig()), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		const loader = createRuntimeConfigLoader({ fetchImpl });
		const registration = {
			runtimeUrl: "https://runtime.example.com/base",
			cacheTtlMs: 1_000,
		};

		await expect(loader.load("machine-4", registration)).rejects.toThrow(
			/invalid runtime config/i,
		);
	});

	it("requires D1-backed storage helpers for runtime metadata access", async () => {
		const env = {};

		await expect(getRuntimeRegistration("machine-5", env)).rejects.toThrow(
			/D1 binding is required for runtime reads/i,
		);
		await expect(getRuntimeConfig("machine-5", env)).rejects.toThrow(
			/D1 binding is required for runtime config reads/i,
		);
	});

	it("fetches from new runtimeUrl when registration changes instead of returning stale cache", async () => {
		let nowMs = 30_000;
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify(createValidRuntimeConfig({ settings: { source: "old-url" } })),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ providers: { old: { id: "old" } } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify(createValidRuntimeConfig({ settings: { source: "new-url" } })),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ providers: { newer: { id: "newer" } } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

		const loader = createRuntimeConfigLoader({
			fetchImpl,
			now: () => nowMs,
		});

		const oldRegistration = {
			runtimeUrl: "https://old.example.com/base",
			cacheTtlMs: 10_000,
		};
		const newRegistration = {
			runtimeUrl: "https://new.example.com/base",
			cacheTtlMs: 10_000,
		};

		const oldConfig = await loader.load("machine-7", oldRegistration);
		nowMs += 2_000;
		const newConfig = await loader.load("machine-7", newRegistration);

		expect(oldConfig.settings.source).toBe("old-url");
		expect(newConfig.settings.source).toBe("new-url");
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			"https://old.example.com/base/runtime.json",
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			3,
			"https://new.example.com/base/runtime.json",
		);
	});

	it("invalidates cached runtime config explicitly", async () => {
		const fetchImpl = vi.fn(async (url) => {
			if (String(url).endsWith("/eligible.json")) {
				return new Response(
					JSON.stringify({
						providers: {
							current: { id: `eligible-${fetchImpl.mock.calls.length}` },
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}

			return new Response(
				JSON.stringify(
					createValidRuntimeConfig({
						settings: { source: `runtime-${fetchImpl.mock.calls.length}` },
					}),
				),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});

		const loader = createRuntimeConfigLoader({ fetchImpl, now: () => 50_000 });
		const registration = {
			runtimeUrl: "https://runtime.example.com/base",
			cacheTtlMs: 60_000,
		};

		const first = await loader.load("machine-8", registration);
		loader.invalidate("machine-8", registration);
		const second = await loader.load("machine-8", registration);

		expect(first.settings.source).not.toBe(second.settings.source);
		expect(fetchImpl).toHaveBeenCalledTimes(4);
	});

	it("requires D1-backed invalidation through storage helper", async () => {
		await expect(invalidateRuntimeConfig("machine-9", {})).rejects.toThrow(
			/D1 binding is required for runtime config invalidation/i,
		);
	});
});

describe("isValidRuntimeConfig", () => {
	it("requires the minimum runtime config shape", () => {
		expect(isValidRuntimeConfig(createValidRuntimeConfig())).toBe(true);
		expect(isValidRuntimeConfig(null)).toBe(false);
		expect(isValidRuntimeConfig({})).toBe(false);
		expect(isValidRuntimeConfig(createValidRuntimeConfig({ providers: [] }))).toBe(false);
	});
});
