import { describe, expect, it } from "vitest";
import {
	handleAdminRegister,
	handleAdminRuntimeRefresh,
	handleAdminStatusJson,
} from "../../cloud/src/handlers/admin.js";
import { handleSync } from "../../cloud/src/handlers/sync.js";

const TEST_WORKER_SHARED_VALUE = "test-shared-value";

function createMockDb() {
	const state = {
		workerRegistry: null,
		providerSync: [],
		runtimeApiKeys: [],
		runtimeAliases: [],
		runtimeCombos: [],
		runtimeSettings: null,
	};

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
						return state.workerRegistry?.worker_id === bindings[0]
							? { ...state.workerRegistry }
							: null;
					}
					if (normalized.includes("FROM runtime_settings")) {
						return state.runtimeSettings?.machine_id === bindings[0]
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
								.filter((row) => row.machine_id === runtimeId)
								.map((row) => ({ ...row })),
						};
					}
					if (normalized.includes("FROM runtime_api_keys")) {
						return {
							results: state.runtimeApiKeys
								.filter((row) => row.machine_id === runtimeId)
								.map((row) => ({ ...row })),
						};
					}
					if (normalized.includes("FROM runtime_model_aliases")) {
						return {
							results: state.runtimeAliases
								.filter((row) => row.machine_id === runtimeId)
								.map((row) => ({ ...row })),
						};
					}
					if (normalized.includes("FROM runtime_combos")) {
						return {
							results: state.runtimeCombos
								.filter((row) => row.machine_id === runtimeId)
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
		CLOUD_SHARED_SECRET: TEST_WORKER_SHARED_VALUE,
		DB: createMockDb(),
	};
}

describe("deprecated worker-side write paths", () => {
	it("rejects sync POST writes to non-shared runtime namespaces", async () => {
		const env = createEnv();
		const response = await handleSync(
			new Request("https://worker.example.com/sync/machine-1", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": TEST_WORKER_SHARED_VALUE,
				},
				body: JSON.stringify({ providers: {}, settings: {} }),
			}),
			env,
			{},
		);
		const payload = await response.json();

		expect(response.status).toBe(404);
		expect(payload.error).toContain("Unsupported runtime namespace");
	});

	it("rejects sync/shared POST writes when the worker has no shared registration state", async () => {
		const env = createEnv();
		const response = await handleSync(
			new Request("https://worker.example.com/sync/shared", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": TEST_WORKER_SHARED_VALUE,
				},
				body: JSON.stringify({ providers: {}, settings: {} }),
			}),
			env,
			{},
		);
		const payload = await response.json();

		expect(response.status).toBe(404);
		expect(payload.error).toContain("Shared runtime not registered");
	});

	it("returns 410 for admin runtime refresh because live sync now goes through /sync/shared", async () => {
		const env = createEnv();

		await handleAdminRegister(
			new Request("https://worker.example.com/admin/register", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": TEST_WORKER_SHARED_VALUE,
				},
				body: JSON.stringify({}),
			}),
			env,
		);

		const response = await handleAdminRuntimeRefresh(
			new Request("https://worker.example.com/admin/runtime/refresh", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": TEST_WORKER_SHARED_VALUE,
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
			new Request("https://worker.example.com/admin/register", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Cloud-Secret": TEST_WORKER_SHARED_VALUE,
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
			new Request("https://worker.example.com/admin/status.json", {
				headers: { "X-Cloud-Secret": TEST_WORKER_SHARED_VALUE },
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
});
