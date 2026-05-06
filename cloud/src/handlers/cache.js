import { errorResponse } from "open-sse/utils/error.js";
import { extractBearerToken, parseApiKey } from "../utils/apiKey.js";
import * as log from "../utils/logger.js";

const SHARED_RUNTIME_ID = "shared";

export async function handleCacheClear(request, env) {
	const apiKey = extractBearerToken(request);
	if (!apiKey) {
		return errorResponse(401, "Missing API key");
	}

	try {
		await request.json().catch(() => ({}));

		const parsed = await parseApiKey(apiKey);
		if (!parsed) {
			return errorResponse(401, "Invalid API key format");
		}

		// No worker cache layer remains; keep the endpoint as a shared-runtime no-op.
		log.info(
			"CACHE",
			`Cache clear requested for runtime: ${SHARED_RUNTIME_ID} (no-op)`,
		);

		return new Response(
			JSON.stringify({
				success: true,
				runtimeId: SHARED_RUNTIME_ID,
				message: "No cache layer",
			}),
			{
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
				},
			},
		);
	} catch (error) {
		return errorResponse(500, error.message);
	}
}
