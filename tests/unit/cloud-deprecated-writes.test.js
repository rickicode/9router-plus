import { describe, expect, it } from "vitest";
import {
	handleAdminRegister,
	handleAdminRuntimeRefresh,
	handleAdminStatusJson,
} from "../../cloud/src/handlers/admin.js";
import { handleSqliteBackupUpload } from "../../cloud/src/handlers/r2backup.js";
import { handleSync } from "../../cloud/src/handlers/sync.js";
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

describe("deprecated worker-side write paths", () => {
	it("rejects sync POST writes when the worker has no shared registration state", async () => {
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

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(payload.error).toBeTruthy();
	});

	it("rejects worker-side SQLite backup uploads", async () => {
		const response = await handleSqliteBackupUpload(
			new Request("https://worker.example.com/r2/backup/sqlite/machine-1", {
				method: "POST",
			}),
			{},
		);
		const payload = await response.json();

		expect(response.status).toBe(410);
		expect(payload.error).toContain("deprecated");
		expect(payload.writer).toBe("9router-plus");
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
