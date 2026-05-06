import { describe, expect, it } from "vitest";

import {
	handleAdminRegister,
	handleAdminRuntimeRefresh,
	handleAdminStatusJson,
	handleAdminUnregister,
} from "../../cloud/src/handlers/admin.js";
import {
	getRuntimeData,
	saveRuntimeData,
} from "../../cloud/src/services/storage.js";

function createMockDb() {
	const state = {
		workerRegistry: null,
		providerSync: [],
		runtimeState: [],
		runtimeApiKeys: [],
		runtimeAliases: [],
		runtimeCombos: [],
		runtimeSettings: null,
	};

	function matchesMachine(row, runtimeId) {
		return row.machine_id === runtimeId;
	}

	return {
		prepare(sql) {
			const normalized = sql.replace(/\s+/g, " ").trim();
			let bindings = [];
			const statement = {
				bind(...args) {
					bindings = args;
					return statement;
				},
				async first() {
					if (normalized.includes("FROM worker_registry")) {
						const runtimeId = bindings[0];
						return state.workerRegistry?.worker_id === runtimeId
							? { ...state.workerRegistry }
							: null;
					}
					if (normalized.includes("FROM runtime_settings")) {
						const runtimeId = bindings[0];
						return state.runtimeSettings?.machine_id === runtimeId
							? { ...state.runtimeSettings }
							: null;
					}
					return null;
				},
				async all() {
					const runtimeId = bindings[0];
					if (normalized.includes("FROM provider_sync s")) {
						return {
							results: state.providerSync
								.filter((row) => matchesMachine(row, runtimeId))
								.map((row) => ({ ...row })),
						};
					}
					if (normalized.includes("FROM runtime_api_keys")) {
						return {
							results: state.runtimeApiKeys
								.filter((row) => matchesMachine(row, runtimeId))
								.map((row) => ({ ...row })),
						};
					}
					if (normalized.includes("FROM runtime_model_aliases")) {
						return {
							results: state.runtimeAliases
								.filter((row) => matchesMachine(row, runtimeId))
								.map((row) => ({ ...row })),
						};
					}
					if (normalized.includes("FROM runtime_combos")) {
						return {
							results: state.runtimeCombos
								.filter((row) => matchesMachine(row, runtimeId))
								.map((row) => ({ ...row })),
						};
					}
					return { results: [] };
				},
				async run() {
					if (normalized.includes("INSERT INTO worker_registry")) {
						state.workerRegistry = {
							worker_id: bindings[0],
							runtime_url: bindings[1],
							cache_ttl_seconds: bindings[2],
							registered_at: bindings[3],
							rotated_at: bindings[4],
							shared_secret_configured_at: bindings[5],
							runtime_refresh_requested_at: bindings[6],
							runtime_artifacts_loaded_at: bindings[7],
							updated_at: bindings[8],
						};
						return { success: true };
					}
					if (normalized.includes("DELETE FROM worker_registry")) {
						state.workerRegistry = null;
						return { success: true };
					}
					return { success: true };
				},
			};
			return statement;
		},
		async batch(statements) {
			for (const statement of statements) {
				if (statement?.run) {
					await statement.run();
				}
			}
			return [];
		},
		__state: state,
	};
}

function createEnv() {
	return {
		CLOUD_SHARED_SECRET: "super-secret-1234",
		DB: createMockDb(),
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
		const stored = await getRuntimeData("shared", env);

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({
			success: true,
			authMode: "shared-secret",
			version: expect.any(String),
		});
		expect(payload.runtimeUrl).toBeUndefined();
		expect(payload.runtimeId).toBeUndefined();
		expect(stored.meta).toMatchObject({
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

		const firstStored = await getRuntimeData("shared", env);

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

		const secondStored = await getRuntimeData("shared", env);

		expect(secondStored.meta.registeredAt).toBe(firstStored.meta.registeredAt);
		expect(secondStored.meta.rotatedAt).not.toBe(firstStored.meta.rotatedAt);
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
		const stored = await getRuntimeData("shared", env);

		expect(response.status).toBe(401);
		expect(payload).toMatchObject({ error: "Unauthorized" });
		expect(stored.meta.registeredAt).toBeTruthy();
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

		env.DB.__state.providerSync = [
			{
				machine_id: "shared",
				provider_id: "conn-1",
				provider: "anthropic",
				auth_type: null,
				name: null,
				priority: null,
				global_priority: null,
				default_model: null,
				access_token: null,
				refresh_token: null,
				expires_at: null,
				expires_in: null,
				token_type: null,
				scope: null,
				api_key: null,
				provider_specific_data: "{}",
				is_active: 1,
				routing_status: "blocked",
				health_status: "degraded",
				quota_state: "exhausted",
				auth_state: "ok",
				reason_code: null,
				reason_detail: null,
				next_retry_at: "2026-04-29T01:00:00.000Z",
				reset_at: null,
				backoff_level: 0,
				last_used_at: null,
				consecutive_use_count: 0,
				sticky_until: null,
				sticky_key_hash: null,
				allow_auth_recovery: 1,
				updated_at: new Date().toISOString(),
				sync_updated_at: new Date().toISOString(),
			},
		];
		env.DB.__state.runtimeAliases = [
			{ machine_id: "shared", alias: "smart", target: "anthropic/claude" },
		];
		env.DB.__state.runtimeCombos = [
			{
				machine_id: "shared",
				combo_id: "combo-1",
				payload_json: JSON.stringify({ id: "combo-1", models: ["smart"] }),
			},
		];
		env.DB.__state.runtimeApiKeys = [
			{
				machine_id: "shared",
				key_id: "key-1",
				key_value: "worker-placeholder-key",
				name: null,
				is_active: 1,
			},
		];
		env.DB.__state.runtimeSettings = {
			machine_id: "shared",
			settings_json: JSON.stringify({}),
			strategy: "priority",
			morph_json: null,
			sync_updated_at: new Date().toISOString(),
		};

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
		expect(payload.runtimeId).toBe("shared");
		expect(payload.machineId).toBeUndefined();
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
		const stored = await getRuntimeData("shared", env);

		expect(response.status).toBe(200);
		expect(payload.success).toBe(true);
		expect(stored).toBeNull();
	});
});
