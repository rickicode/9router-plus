import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/services/model.js", () => ({
	getModelInfoCore: vi.fn(),
}));

vi.mock("../../open-sse/handlers/embeddingsCore.js", () => ({
	handleEmbeddingsCore: vi.fn(),
}));

vi.mock("../../open-sse/utils/error.js", async (importOriginal) => {
	const actual = await importOriginal();
	return actual;
});

vi.mock(
	"../../open-sse/services/accountFallback.js",
	async (importOriginal) => {
		const actual = await importOriginal();
		return actual;
	},
);

vi.mock("../../cloud/src/utils/logger.js", () => ({
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

vi.mock("../../cloud/src/utils/apiKey.js", () => ({
	parseApiKey: vi.fn(),
	extractBearerToken: vi.fn(),
}));

vi.mock("../../cloud/src/services/storage.js", () => ({
	getRuntimeConfig: vi.fn(),
	updateRuntimeProviderCredentials: vi.fn(),
	updateRuntimeProviderState: vi.fn(),
}));

import { handleEmbeddings } from "../../cloud/src/handlers/embeddings.js";
import {
	getRuntimeConfig,
	updateRuntimeProviderState,
} from "../../cloud/src/services/storage.js";
import {
	extractBearerToken,
	parseApiKey,
} from "../../cloud/src/utils/apiKey.js";
import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";

const VALID_API_KEY = "sk-mach01-key01-ab12cd34";
const VALID_RESPONSE = {
	object: "list",
	data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
	model: "text-embedding-ada-002",
	usage: { prompt_tokens: 3, total_tokens: 3 },
};

function makeEnv() {
	return { DB: {}, KV: {} };
}

function makeRuntime(overrides = {}) {
	return {
		apiKeys: [{ key: VALID_API_KEY, label: "test", isActive: true }],
		providers: {
			"conn-001": {
				provider: "openai",
				apiKey: "sk-openai-provider-key",
				isActive: true,
				priority: 1,
				routingStatus: "eligible",
				authState: "ok",
				healthStatus: "healthy",
				quotaState: "ok",
				reasonCode: "unknown",
				reasonDetail: null,
				nextRetryAt: null,
				resetAt: null,
				backoffLevel: 0,
			},
		},
		modelAliases: {},
		...overrides,
	};
}

function makeRequest(
	method = "POST",
	body = null,
	authHeader = `Bearer ${VALID_API_KEY}`,
	url = "https://9cli.hxd.app/v1/embeddings",
) {
	const headers = { "Content-Type": "application/json" };
	if (authHeader) headers.Authorization = authHeader;

	return new Request(url, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
}

describe("handleEmbeddings", () => {
	beforeEach(() => {
		vi.mocked(extractBearerToken).mockReturnValue(VALID_API_KEY);
		vi.mocked(parseApiKey).mockResolvedValue({
			runtimeScope: "mach01",
			keyId: "key01",
			isNewFormat: true,
		});
		vi.mocked(getRuntimeConfig).mockResolvedValue(makeRuntime());
		vi.mocked(updateRuntimeProviderState).mockImplementation(
			async (_runtimeId, _connectionId, updater) => {
				const conn = makeRuntime().providers["conn-001"];
				updater(conn);
				return { providers: { "conn-001": conn } };
			},
		);
		vi.mocked(getModelInfoCore).mockResolvedValue({
			provider: "openai",
			model: "text-embedding-ada-002",
		});
		vi.mocked(handleEmbeddingsCore).mockResolvedValue({
			success: true,
			response: new Response(JSON.stringify(VALID_RESPONSE), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
				},
			}),
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("returns CORS headers for OPTIONS", async () => {
		const req = makeRequest("OPTIONS", null, null);
		const res = await handleEmbeddings(req, makeEnv(), {});

		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("rejects missing Authorization header", async () => {
		vi.mocked(extractBearerToken).mockReturnValue(null);

		const req = makeRequest(
			"POST",
			{
				model: "openai/text-embedding-ada-002",
				input: "hello",
			},
			null,
		);
		const res = await handleEmbeddings(req, makeEnv(), {});

		expect(res.status).toBe(401);
	});

	it("rejects invalid key format", async () => {
		vi.mocked(parseApiKey).mockResolvedValue(null);

		const req = makeRequest("POST", {
			model: "openai/text-embedding-ada-002",
			input: "hello",
		});
		const res = await handleEmbeddings(req, makeEnv(), {});

		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.message).toMatch(/invalid api key format/i);
	});

	it("accepts legacy-format keys if they exist in shared runtime", async () => {
		vi.mocked(extractBearerToken).mockReturnValue("sk-oldfmt8");
		vi.mocked(parseApiKey).mockResolvedValue({
			runtimeScope: null,
			keyId: "oldfmt8",
			isNewFormat: false,
		});
		vi.mocked(getRuntimeConfig).mockResolvedValue(
			makeRuntime({
				apiKeys: [{ key: "sk-oldfmt8", isActive: true }],
			}),
		);

		const req = makeRequest(
			"POST",
			{ model: "openai/text-embedding-ada-002", input: "hello" },
			"Bearer sk-oldfmt8",
		);
		const res = await handleEmbeddings(req, makeEnv(), {});

		expect(res.status).toBe(200);
	});

	it("rejects valid-format keys not present in shared runtime", async () => {
		vi.mocked(getRuntimeConfig).mockResolvedValue(
			makeRuntime({
				apiKeys: [{ key: "sk-different-key", isActive: true }],
			}),
		);

		const req = makeRequest("POST", {
			model: "openai/text-embedding-ada-002",
			input: "hello",
		});
		const res = await handleEmbeddings(req, makeEnv(), {});

		expect(res.status).toBe(401);
	});

	it("rejects missing model", async () => {
		const req = makeRequest("POST", { input: "hello" });
		const res = await handleEmbeddings(req, makeEnv(), {});

		expect(res.status).toBe(400);
	});

	it("rejects missing input", async () => {
		const req = makeRequest("POST", { model: "openai/text-embedding-ada-002" });
		const res = await handleEmbeddings(req, makeEnv(), {});

		expect(res.status).toBe(400);
	});

	it("delegates successful requests to handleEmbeddingsCore", async () => {
		const req = makeRequest("POST", {
			model: "openai/text-embedding-ada-002",
			input: "Hello world",
		});
		const res = await handleEmbeddings(req, makeEnv(), {});

		expect(res.status).toBe(200);
		expect(handleEmbeddingsCore).toHaveBeenCalledOnce();
		const callArgs = vi.mocked(handleEmbeddingsCore).mock.calls[0][0];
		expect(callArgs.body.input).toBe("Hello world");
		expect(callArgs.modelInfo.provider).toBe("openai");
	});

	it("returns 503 with Retry-After when all accounts are rate-limited", async () => {
		const retryAt = new Date(Date.now() + 60_000).toISOString();
		vi.mocked(getRuntimeConfig).mockResolvedValue(
			makeRuntime({
				providers: {
					"conn-001": {
						provider: "openai",
						apiKey: "sk-key",
						isActive: true,
						priority: 1,
						routingStatus: "blocked",
						authState: "ok",
						healthStatus: "healthy",
						quotaState: "exhausted",
						reasonCode: "quota_exhausted",
						reasonDetail: "Rate limit exceeded",
						nextRetryAt: retryAt,
						resetAt: retryAt,
						backoffLevel: 1,
					},
				},
			}),
		);

		const req = makeRequest("POST", {
			model: "openai/text-embedding-ada-002",
			input: "hello",
		});
		const res = await handleEmbeddings(req, makeEnv(), {});

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBeTruthy();
	});

	it("returns 400 when no provider credentials exist", async () => {
		vi.mocked(getRuntimeConfig).mockResolvedValue(
			makeRuntime({
				providers: {},
			}),
		);

		const req = makeRequest("POST", {
			model: "openai/text-embedding-ada-002",
			input: "hello",
		});
		const res = await handleEmbeddings(req, makeEnv(), {});

		expect(res.status).toBe(400);
	});

	it("ignores legacy runtime path segments and still authenticates via shared runtime", async () => {
		const req = makeRequest(
			"POST",
			{ model: "openai/text-embedding-ada-002", input: "hello" },
			`Bearer ${VALID_API_KEY}`,
			"https://9cli.hxd.app/mach01/v1/embeddings",
		);
		const res = await handleEmbeddings(req, makeEnv(), {});

		expect(res.status).toBe(200);
		expect(vi.mocked(parseApiKey)).toHaveBeenCalled();
		expect(vi.mocked(getRuntimeConfig)).toHaveBeenCalledWith(
			"shared",
			expect.anything(),
		);
	});
});
