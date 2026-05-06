import { getRuntimeConfig } from "../services/storage.js";
import { extractBearerToken, parseApiKey } from "../utils/apiKey.js";

const SHARED_RUNTIME_ID = "shared";

/**
 * Verify API key endpoint against the shared runtime namespace.
 * Legacy key formats still parse, but runtime routing no longer depends on
 * runtime-scoped metadata embedded in the key.
 */
export async function handleVerify(request, env) {
	const apiKey = extractBearerToken(request);
	if (!apiKey) {
		return jsonResponse(
			{ error: "Missing or invalid Authorization header" },
			401,
		);
	}

	const parsed = await parseApiKey(apiKey);
	if (!parsed) {
		return jsonResponse({ error: "Invalid API key format" }, 401);
	}

	const data = await getRuntimeConfig(SHARED_RUNTIME_ID, env);
	if (!data) {
		return jsonResponse({ error: "Shared runtime not found" }, 404);
	}

	const isValid =
		data.apiKeys?.some((k) => k.isActive !== false && k.key === apiKey) ||
		false;
	if (!isValid) {
		return jsonResponse({ error: "Invalid API key" }, 401);
	}

	return jsonResponse({
		valid: true,
		runtimeId: SHARED_RUNTIME_ID,
		providersCount: Object.keys(data.providers || {}).length,
	});
}

function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}
