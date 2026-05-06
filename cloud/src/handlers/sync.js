import { updateLastSync } from "../services/state.js";
import {
	deleteRuntimeData,
	getRuntimeConfig,
	getRuntimeData,
	saveRuntimeSyncPayload,
} from "../services/storage.js";
import * as log from "../utils/logger.js";
import { isWorkerSharedSecretValid } from "../utils/secret.js";

const WORKER_RECORD_ID = "shared";
const SHARED_RUNTIME_ID = "shared";

const CORS_HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

function normalizeRuntimeSyncPayload(body = {}) {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { error: "Invalid JSON body" };
	}

	if (
		!body.providers ||
		typeof body.providers !== "object" ||
		Array.isArray(body.providers)
	) {
		return { error: "Missing providers object" };
	}

	if (
		body.modelAliases !== undefined &&
		(!body.modelAliases ||
			typeof body.modelAliases !== "object" ||
			Array.isArray(body.modelAliases))
	) {
		return { error: "Invalid modelAliases object" };
	}

	if (
		body.settings !== undefined &&
		(!body.settings ||
			typeof body.settings !== "object" ||
			Array.isArray(body.settings))
	) {
		return { error: "Invalid settings object" };
	}

	if (body.apiKeys !== undefined && !Array.isArray(body.apiKeys)) {
		return { error: "Invalid apiKeys array" };
	}

	if (body.combos !== undefined && !Array.isArray(body.combos)) {
		return { error: "Invalid combos array" };
	}

	return {
		generatedAt:
			typeof body.generatedAt === "string" && body.generatedAt
				? body.generatedAt
				: new Date().toISOString(),
		strategy:
			typeof body.strategy === "string" && body.strategy
				? body.strategy
				: "priority",
		providers: body.providers,
		modelAliases: body.modelAliases || {},
		combos: body.combos || [],
		apiKeys: body.apiKeys || [],
		settings: body.settings || {},
	};
}

export async function handleSync(request, env, ctx) {
	const url = new URL(request.url);
	const runtimeId = url.pathname.split("/")[2]; // /sync/shared

	// Handle CORS preflight
	if (request.method === "OPTIONS") {
		return new Response(null, {
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "*",
			},
		});
	}

	if (!runtimeId) {
		log.warn("SYNC", "Missing runtime namespace in path");
		return jsonResponse({ error: "Missing runtime namespace" }, 400);
	}

	if (runtimeId !== SHARED_RUNTIME_ID) {
		log.warn("SYNC", "Unsupported runtime namespace", { runtimeId });
		return jsonResponse({ error: "Unsupported runtime namespace" }, 404);
	}

	switch (request.method) {
		case "GET":
			return handleGet(request, SHARED_RUNTIME_ID, env);
		case "POST":
			return handlePost(request, SHARED_RUNTIME_ID, env);
		case "DELETE":
			return handleDelete(request, SHARED_RUNTIME_ID, env);
		default:
			return jsonResponse({ error: "Method not allowed" }, 405);
	}
}

async function authorizeSharedRuntime(
	request,
	runtimeId,
	env,
	{ requireExisting = true } = {},
) {
	const data = await getRuntimeData(WORKER_RECORD_ID, env);

	if (!data) {
		if (requireExisting) {
			log.warn("SYNC", "Shared runtime not registered", { runtimeId });
			return {
				ok: false,
				response: jsonResponse(
					{ error: "Shared runtime not registered. Call POST /admin/register first." },
					404,
				),
			};
		}
		return { ok: true, data: null };
	}

	if (!isWorkerSharedSecretValid(request, env)) {
		log.warn("SYNC", "Invalid shared secret", { runtimeId });
		return {
			ok: false,
			response: jsonResponse({ error: "Unauthorized" }, 401),
		};
		}

	return { ok: true, data };
}

async function handleGet(request, runtimeId, env) {
	const auth = await authorizeSharedRuntime(request, runtimeId, env);
	if (!auth.ok) return auth.response;

	const data = await getRuntimeConfig(runtimeId, env, { forceRefresh: true });
	log.info("SYNC", "Runtime config retrieved", { runtimeId });
	return jsonResponse({
		success: true,
		runtimeId,
		data,
	});
}

async function handlePost(request, runtimeId, env) {
	const auth = await authorizeSharedRuntime(request, runtimeId, env);
	if (!auth.ok) return auth.response;

	let body;
	try {
		body = await request.json();
	} catch {
		log.warn("SYNC", "Invalid JSON body", { runtimeId });
		return jsonResponse({ error: "Invalid JSON body" }, 400);
	}

	const payload = normalizeRuntimeSyncPayload(body);
	if (payload.error) {
		log.warn("SYNC", payload.error, { runtimeId });
		return jsonResponse({ error: payload.error }, 400);
	}

	const syncResult = await saveRuntimeSyncPayload(runtimeId, payload, env);
	updateLastSync();

	log.info("SYNC", "Publisher runtime payload synced to D1", {
		runtimeId,
		providerCount: syncResult.providerCount,
		modelAliasCount: syncResult.modelAliasCount,
		comboCount: syncResult.comboCount,
		apiKeyCount: syncResult.apiKeyCount,
	});

	return jsonResponse({
		success: true,
		runtimeId,
		syncMode: "publisher-to-d1",
		pruneBehavior:
			"provider_sync/api_keys/model_aliases/combos/settings replaced from publisher payload",
		runtimePreservation:
			"provider_runtime_state preserved for providers still present; deleted for providers pruned from payload",
		receivedAt: new Date().toISOString(),
		generatedAt: syncResult.generatedAt,
		providerCount: syncResult.providerCount,
		modelAliasCount: syncResult.modelAliasCount,
		comboCount: syncResult.comboCount,
		apiKeyCount: syncResult.apiKeyCount,
	});
}

async function handleDelete(request, runtimeId, env) {
	const auth = await authorizeSharedRuntime(request, runtimeId, env);
	if (!auth.ok) return auth.response;

	await deleteRuntimeData(runtimeId, env);

	log.info("SYNC", "Runtime config deleted", { runtimeId });
	return jsonResponse({
		success: true,
		runtimeId,
		message: "Runtime config deleted successfully",
	});
}

function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: CORS_HEADERS,
	});
}
