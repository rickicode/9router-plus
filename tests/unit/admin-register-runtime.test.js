import { describe, expect, it } from "vitest";

import {
	handleAdminRegister,
	handleAdminRuntimeRefresh,
	handleAdminStatusJson,
	handleAdminUnregister,
} from "../../cloud/src/handlers/admin.js";
import {
	getMachineData,
	saveMachineData,
} from "../../cloud/src/services/storage.js";

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
					},
				};
			},
			async put(key, value) {
				store.set(key, value);
			},
			async delete(key) {
				store.delete(key);
			},
		},
	};
}

describe("cloud admin shared-secret registration", () => {
	it("returns 503 when the worker shared secret env is missing", async () => {
		const env = createEnv();
		env.CLOUD_SHARED_SECRET = "";

		const request = new Request("https://example.com/admin/register", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Cloud-Secret": "super-secret-1234",
			},
			body: JSON.stringify({}),
		});

		const response = await handleAdminRegister(request, env);
		const payload = await response.json();

		expect(response.status).toBe(503);
		expect(payload).toMatchObject({
			error: "Worker shared secret is not configured",
		});
	});

	it("stores shared-secret registration metadata without runtimeUrl state", async () => {
		const env = createEnv();

		const request = new Request("https://example.com/admin/register", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Cloud-Secret": "super-secret-1234",
			},
			body: JSON.stringify({
				registeredBy: "dashboard",
			}),
		});

		const response = await handleAdminRegister(request, env);
		const payload = await response.json();
		const stored = await getMachineData("shared", env);

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({
			success: true,
			authMode: "shared-secret",
			version: expect.any(String),
		});
		expect(payload.runtimeUrl).toBeUndefined();
		expect(stored.meta).toMatchObject({
			registeredBy: "dashboard",
			registeredAt: expect.any(String),
			rotatedAt: expect.any(String),
			sharedSecretConfiguredAt: expect.any(String),
		});
		expect(stored.meta.runtimeUrl).toBeUndefined();
		expect(stored.meta.cacheTtlSeconds).toBeUndefined();
	});

	it("preserves the first registeredAt timestamp across re-registration", async () => {
		const env = createEnv();

		await handleAdminRegister(
			new Request("https://example.com/admin/register", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": "super-secret-1234",
				},
				body: JSON.stringify({ registeredBy: "first-client" }),
			}),
			env,
		);

		const firstStored = await getMachineData("shared", env);

		await handleAdminRegister(
			new Request("https://example.com/admin/register", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": "super-secret-1234",
				},
				body: JSON.stringify({ registeredBy: "second-client" }),
			}),
			env,
		);

		const secondStored = await getMachineData("shared", env);

		expect(secondStored.meta.registeredAt).toBe(firstStored.meta.registeredAt);
		expect(secondStored.meta.registeredBy).toBe("second-client");
	});

	it("rejects mismatched secret without overwriting registration metadata", async () => {
		const env = createEnv();

		await handleAdminRegister(
			new Request("https://example.com/admin/register", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": "super-secret-1234",
				},
				body: JSON.stringify({ registeredBy: "trusted" }),
			}),
			env,
		);

		const response = await handleAdminRegister(
			new Request("https://example.com/admin/register", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": "wrong-secret-1234",
				},
				body: JSON.stringify({ registeredBy: "attacker" }),
			}),
			env,
		);
		const payload = await response.json();
		const stored = await getMachineData("shared", env);

		expect(response.status).toBe(401);
		expect(payload).toMatchObject({ error: "Unauthorized" });
		expect(stored.meta.registeredBy).toBe("trusted");
	});

	it("returns a deprecation response for admin runtime refresh", async () => {
		const env = createEnv();

		await handleAdminRegister(
			new Request("https://example.com/admin/register", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": "super-secret-1234",
				},
				body: JSON.stringify({}),
			}),
			env,
		);

		const response = await handleAdminRuntimeRefresh(
			new Request("https://example.com/admin/runtime/refresh", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": "super-secret-1234",
				},
				body: JSON.stringify({}),
			}),
			env,
		);
		const payload = await response.json();

		expect(response.status).toBe(410);
		expect(payload).toMatchObject({
			writer: "9router",
			liveSource: "d1",
		});
	});

	it("reports effective synced runtime state in admin status", async () => {
		const env = createEnv();

		await handleAdminRegister(
			new Request("https://example.com/admin/register", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": "super-secret-1234",
				},
				body: JSON.stringify({}),
			}),
			env,
		);

		await saveMachineData(
			"shared",
			{
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
					},
				},
				modelAliases: { smart: "anthropic/claude" },
				combos: [{ id: "combo-1", models: ["smart"] }],
				apiKeys: [{ key: "worker-placeholder-key", isActive: true }],
				settings: {},
				meta: {
					registeredAt: new Date().toISOString(),
					rotatedAt: new Date().toISOString(),
					sharedSecretConfiguredAt: new Date().toISOString(),
				},
			},
			env,
		);

		const response = await handleAdminStatusJson(
			new Request("https://example.com/admin/status.json", {
				headers: { "X-Cloud-Secret": "super-secret-1234" },
			}),
			env,
		);
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.counts).toMatchObject({
			providers: 1,
			modelAliases: 1,
			combos: 1,
			apiKeys: 1,
		});
		expect(payload.providers[0]).toMatchObject({
			id: "conn-1",
			routingStatus: "blocked",
			quotaState: "exhausted",
			healthStatus: "degraded",
		});
	});

	it("unregisters the worker record", async () => {
		const env = createEnv();

		await handleAdminRegister(
			new Request("https://example.com/admin/register", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": "super-secret-1234",
				},
				body: JSON.stringify({}),
			}),
			env,
		);

		const response = await handleAdminUnregister(
			new Request("https://example.com/admin/unregister", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": "super-secret-1234",
				},
				body: JSON.stringify({}),
			}),
			env,
		);
		const payload = await response.json();
		const stored = await getMachineData("shared", env);

		expect(response.status).toBe(200);
		expect(payload.success).toBe(true);
		expect(stored).toBeNull();
	});
});
