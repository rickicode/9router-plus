import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import {
	checkFallbackError,
	formatRetryAfter,
	getEarliestRateLimitedUntil,
	getUnavailableUntil,
	isAccountUnavailable,
} from "open-sse/services/accountFallback.js";
import {
	getComboModelsFromData,
	handleComboChat,
} from "open-sse/services/combo.js";
import { getModelInfoCore } from "open-sse/services/model.js";
import { errorResponse } from "open-sse/utils/error.js";
import { selectCredential } from "../services/routing.js";
import {
	getRuntimeConfig,
	updateRuntimeProviderCredentials,
	updateRuntimeProviderState,
} from "../services/storage.js";
import { refreshTokenByProvider } from "../services/tokenRefresh.js";
import { recordUsage, recordUsageEvent } from "../services/usage.js";
import { extractBearerToken, parseApiKey } from "../utils/apiKey.js";
import * as log from "../utils/logger.js";

const SHARED_RUNTIME_ID = "shared";
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const refreshLocks = new Map();

function isProviderRequestValidationError(status, errorText, provider = null) {
	if (Number(status) !== 400) return false;
	const normalized = String(errorText || "").toLowerCase();
	if (!normalized) return false;

	return (
		normalized.includes("content_length_exceeds_threshold") ||
		normalized.includes("input is too long") ||
		(provider === "kiro" && normalized.includes("content length"))
	);
}

async function getModelInfo(modelStr, runtimeId, env) {
	const data = await getRuntimeConfig(runtimeId, env);
	if (!data) {
		return getModelInfoCore(modelStr, {});
	}
	return getModelInfoCore(modelStr, data?.modelAliases || {});
}

/**
 * Handle chat requests against the shared runtime namespace.
 * Legacy API key formats still parse, but routing no longer depends on
 * runtime-scoped key metadata or legacy URL path segments.
 */
export async function handleChat(request, env, ctx) {
	if (request.method === "OPTIONS") {
		return new Response(null, {
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				"Access-Control-Allow-Headers": "*",
			},
		});
	}

	const apiKey = extractBearerToken(request);
	if (!apiKey)
		return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");

	const parsed = await parseApiKey(apiKey);
	if (!parsed)
		return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key format");

	const runtimeId = SHARED_RUNTIME_ID;

	if (!(await validateApiKey(request, runtimeId, env))) {
		return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
	}

	log.info("CHAT", `${runtimeId} | ${body.model}`, {
		stream: body.stream !== false,
	});

	const modelStr = body.model;
	if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");

	// Check if model is a combo
	const data = await getRuntimeConfig(runtimeId, env);
	if (!data) {
		return errorResponse(
			HTTP_STATUS.SERVICE_UNAVAILABLE,
			"Runtime config unavailable",
		);
	}
	const comboModels = getComboModelsFromData(modelStr, data?.combos || []);

	if (comboModels) {
		log.info("COMBO", `"${modelStr}" with ${comboModels.length} models`);
		return handleComboChat({
			body,
			models: comboModels,
			handleSingleModel: (reqBody, model) =>
				handleSingleModelChat(reqBody, model, runtimeId, env, request),
			log,
		});
	}

	// Single model request
	return handleSingleModelChat(body, modelStr, runtimeId, env, request);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, runtimeId, env, request) {
	const requestStartedAt = Date.now();
	const modelInfo = await getModelInfo(modelStr, runtimeId, env);
	if (!modelInfo.provider)
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

	const { provider, model } = modelInfo;
	log.info("MODEL", `${provider.toUpperCase()} | ${model}`);

	const excludedConnectionIds = new Set();
	let lastError = null;
	let lastStatus = null;
	let retryCount = 0;
	const initialRuntime = await getRuntimeConfig(runtimeId, env);
	if (!initialRuntime) {
		return errorResponse(
			HTTP_STATUS.SERVICE_UNAVAILABLE,
			"Runtime config unavailable",
		);
	}
	const providerConnectionCount = Object.values(
		initialRuntime.providers || {},
	).filter((conn) => conn.provider === provider && conn.isActive).length;
	const MAX_RETRIES = Math.max(10, Math.min(providerConnectionCount, 1000));

	while (retryCount < MAX_RETRIES) {
		retryCount++;
		const data = await getRuntimeConfig(runtimeId, env);
		if (!data) {
			return errorResponse(
				HTTP_STATUS.SERVICE_UNAVAILABLE,
				"Runtime config unavailable",
			);
		}
		let connection;
		try {
			const apiKey = extractBearerToken(request);
			connection = await selectCredential(
				data,
				provider,
				apiKey || "default",
				env,
			);
			if (!connection?.id) {
				log.debug(
					"ROUTING",
					"selectCredential returned connection without id",
					{
						provider,
						runtimeId,
						selectedKeys: connection ? Object.keys(connection) : [],
					},
				);
			}
		} catch (error) {
			log.warn("ROUTING", error.message);
			if (
				error?.message === `No available credentials for provider: ${provider}`
			) {
				const availability = await getProviderCredentials(
					runtimeId,
					provider,
					env,
					excludedConnectionIds,
				);
				if (availability?.allRateLimited) {
					const retryAfterSec = Math.ceil(
						(new Date(availability.retryAfter).getTime() - Date.now()) / 1000,
					);
					const msg = `[${provider}/${model}] ${availability.lastError || "Unavailable"} (${availability.retryAfterHuman})`;
					const status =
						Number(availability.lastErrorCode) ||
						HTTP_STATUS.SERVICE_UNAVAILABLE;
					return new Response(JSON.stringify({ error: { message: msg } }), {
						status,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": String(Math.max(retryAfterSec, 1)),
						},
					});
				}
				return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, error.message);
			}
			return errorResponse(HTTP_STATUS.BAD_REQUEST, error.message);
		}

		let credentials = connection;
		if (excludedConnectionIds.has(credentials?.id)) {
			// Mark initially selected credential as excluded before fallback
			if (credentials?.id) {
				excludedConnectionIds.add(credentials.id);
			}
			credentials = await getProviderCredentials(
				runtimeId,
				provider,
				env,
				excludedConnectionIds,
			);
		}
		if (!credentials || credentials.allRateLimited) {
			if (credentials?.allRateLimited) {
				const retryAfterSec = Math.ceil(
					(new Date(credentials.retryAfter).getTime() - Date.now()) / 1000,
				);
				const errorMsg = lastError || credentials.lastError || "Unavailable";
				const msg = `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`;
				const status =
					lastStatus ||
					Number(credentials.lastErrorCode) ||
					HTTP_STATUS.SERVICE_UNAVAILABLE;
				log.warn("CHAT", `${provider.toUpperCase()} | ${msg}`);
				return new Response(JSON.stringify({ error: { message: msg } }), {
					status,
					headers: {
						"Content-Type": "application/json",
						"Retry-After": String(Math.max(retryAfterSec, 1)),
					},
				});
			}
			if (excludedConnectionIds.size === 0) {
				return errorResponse(
					HTTP_STATUS.BAD_REQUEST,
					`No credentials for provider: ${provider}`,
				);
			}
			log.warn("CHAT", `${provider.toUpperCase()} | no more accounts`);
			return new Response(
				JSON.stringify({ error: lastError || "All accounts unavailable" }),
				{
					status: lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		log.debug("CHAT", `account=${credentials.id}`, { provider });

		const refreshedCredentials = await checkAndRefreshToken(
			runtimeId,
			provider,
			credentials,
			env,
		);

		// Use shared chatCore
		const result = await handleChatCore({
			body,
			modelInfo: { provider, model },
			credentials: refreshedCredentials,
			log,
			onCredentialsRefreshed: async (newCreds) => {
				await updateCredentials(runtimeId, credentials.id, newCreds, env);
			},
			onRequestSuccess: async () => {
				// Clear error status only if currently has error (optimization)
				await clearAccountError(runtimeId, credentials.id, credentials, env);
			},
		});

		if (result.success) {
			// Extract token counts from response metadata if available
			const inputTokens =
				body.messages?.reduce((sum, msg) => {
					return sum + (msg.content?.length || 0);
				}, 0) || 0;

			// Record usage (output tokens tracked in stream handler if needed)
			if (connection?.id) {
				recordUsage(connection.id, Math.floor(inputTokens / 4), 0);
			} else {
				log.warn("CHAT", "Cannot record usage: connection.id is undefined");
			}
			recordUsageEvent({
				type: "chat",
				endpoint: new URL(request.url).pathname,
				provider,
				model,
				connectionId: connection?.id || credentials?.id || null,
				status: result.response?.status || 200,
				tokensInput: Math.floor(inputTokens / 4),
				tokensOutput: 0,
				latencyMs: Date.now() - requestStartedAt,
			});
			return result.response;
		}

		if (
			isProviderRequestValidationError(result.status, result.error, provider)
		) {
			log.warn(
				"CHAT",
				`Request validation error for ${provider}/${model}; not marking account unavailable`,
			);
			return errorResponse(
				result.status || HTTP_STATUS.BAD_REQUEST,
				result.error || "Bad request",
			);
		}

		const { shouldFallback } = checkFallbackError(result.status, result.error);

		if (shouldFallback) {
			// On error
			if (connection?.id) {
				recordUsage(connection.id, 0, 0, result.error);
			}
			recordUsageEvent({
				type: "chat",
				endpoint: new URL(request.url).pathname,
				provider,
				model,
				connectionId: connection?.id || credentials?.id || null,
				status: result.status,
				tokensInput: 0,
				tokensOutput: 0,
				error: result.error,
				latencyMs: Date.now() - requestStartedAt,
			});
			log.warn(
				"FALLBACK",
				`${provider.toUpperCase()} | ${credentials.id} | ${result.status}`,
			);
			await markAccountUnavailable(
				runtimeId,
				credentials.id,
				result.status,
				result.error,
				env,
			);
			excludedConnectionIds.add(credentials.id);
			lastError = result.error;
			lastStatus = result.status;
			if (retryCount >= MAX_RETRIES) {
				log.error("CHAT", "Max retries exceeded, all accounts failed", {
					provider,
					model,
					attempts: retryCount,
					maxRetries: MAX_RETRIES,
					excludedCount: excludedConnectionIds.size,
					providerConnectionCount,
				});
				return errorResponse(
					HTTP_STATUS.SERVICE_UNAVAILABLE,
					"All accounts unavailable after max retries",
				);
			}
			continue;
		}

		return result.response;
	}

	log.error("CHAT", "Max retries exceeded, all accounts failed", {
		provider,
		model,
		attempts: retryCount,
		maxRetries: MAX_RETRIES,
		excludedCount: excludedConnectionIds.size,
		providerConnectionCount,
	});
	return errorResponse(
		HTTP_STATUS.SERVICE_UNAVAILABLE,
		"All accounts unavailable after max retries",
	);
}

async function checkAndRefreshToken(runtimeId, provider, credentials, env) {
	if (!credentials.expiresAt) return credentials;

	const expiresAt = new Date(credentials.expiresAt).getTime();
	if (expiresAt - Date.now() >= TOKEN_EXPIRY_BUFFER_MS) return credentials;

	const lockKey = credentials.id;

	if (refreshLocks.has(lockKey)) {
		await refreshLocks.get(lockKey);
		const data = await getRuntimeConfig(runtimeId, env);
		return data?.providers?.[credentials.id] || credentials;
	}

	const refreshPromise = (async () => {
		try {
			log.debug("TOKEN", `${provider.toUpperCase()} | expiring, refreshing`);
			const newCredentials = await refreshTokenByProvider(
				provider,
				credentials,
			);
			if (newCredentials?.accessToken) {
				await updateCredentials(runtimeId, credentials.id, newCredentials, env);
				return {
					...credentials,
					accessToken: newCredentials.accessToken,
					refreshToken: newCredentials.refreshToken || credentials.refreshToken,
					expiresAt: newCredentials.expiresIn
						? new Date(
								Date.now() + newCredentials.expiresIn * 1000,
							).toISOString()
						: credentials.expiresAt,
				};
			}
			return credentials;
		} finally {
			refreshLocks.delete(lockKey);
		}
	})();

	refreshLocks.set(lockKey, refreshPromise);
	return await refreshPromise;
}

export async function validateApiKey(request, runtimeId, env) {
	const authHeader = request.headers.get("Authorization");
	if (!authHeader?.startsWith("Bearer ")) return false;

	const apiKey = authHeader.slice(7);
	const data = await getRuntimeConfig(runtimeId, env);
	if (!data) return false;
	return (
		data?.apiKeys?.some((k) => k.isActive !== false && k.key === apiKey) ||
		false
	);
}

async function getProviderCredentials(
	runtimeId,
	provider,
	env,
	excludedConnectionIds = new Set(),
) {
	const data = await getRuntimeConfig(runtimeId, env);
	if (!data?.providers) return null;

	const excludedIds =
		excludedConnectionIds instanceof Set
			? excludedConnectionIds
			: new Set(excludedConnectionIds ? [excludedConnectionIds] : []);

	const providerConnections = Object.entries(data.providers)
		.filter(([connId, conn]) => {
			if (conn.provider !== provider || !conn.isActive) return false;
			if (excludedIds.has(connId)) return false;
			if (isAccountUnavailable(conn)) return false;
			return true;
		})
		.sort((a, b) => (a[1].priority || 999) - (b[1].priority || 999));

	if (providerConnections.length === 0) {
		// Check if accounts exist but all rate limited
		const allConnections = Object.entries(data.providers)
			.filter(([, conn]) => conn.provider === provider && conn.isActive)
			.map(([, conn]) => conn);
		const earliest = getEarliestRateLimitedUntil(allConnections);
		if (earliest) {
			const unavailableConns = allConnections.filter((c) =>
				isAccountUnavailable(c),
			);
			const earliestConn = unavailableConns.sort((a, b) => {
				const aUntil = a.nextRetryAt || a.resetAt;
				const bUntil = b.nextRetryAt || b.resetAt;
				return new Date(aUntil).getTime() - new Date(bUntil).getTime();
			})[0];
			return {
				allRateLimited: true,
				retryAfter: earliest,
				retryAfterHuman: formatRetryAfter(earliest),
				lastError: earliestConn?.reasonDetail || null,
				lastErrorCode: earliestConn?.reasonCode || null,
			};
		}
		return null;
	}

	const [connectionId, connection] = providerConnections[0];

	return {
		id: connectionId,
		apiKey: connection.apiKey,
		accessToken: connection.accessToken,
		refreshToken: connection.refreshToken,
		expiresAt: connection.expiresAt,
		projectId: connection.projectId,
		copilotToken: connection.providerSpecificData?.copilotToken,
		providerSpecificData: connection.providerSpecificData,
		routingStatus: connection.routingStatus,
		authState: connection.authState,
		healthStatus: connection.healthStatus,
		quotaState: connection.quotaState,
		reasonCode: connection.reasonCode,
		reasonDetail: connection.reasonDetail,
		nextRetryAt: connection.nextRetryAt,
		resetAt: connection.resetAt,
		lastCheckedAt: connection.lastCheckedAt,
		updatedAt: connection.updatedAt,
		backoffLevel: connection.backoffLevel,
	};
}

async function markAccountUnavailable(
	runtimeId,
	connectionId,
	status,
	errorText,
	env,
) {
	const updated = await updateRuntimeProviderState(
		runtimeId,
		connectionId,
		(conn) => {
			const backoffLevel = conn.backoffLevel || 0;
			const { cooldownMs, newBackoffLevel } = checkFallbackError(
				status,
				errorText,
				backoffLevel,
			);
			const rateLimitedUntil = getUnavailableUntil(cooldownMs);
			const reason =
				typeof errorText === "string"
					? errorText.slice(0, 100)
					: "Provider error";

			const nowIso = new Date().toISOString();
			conn.backoffLevel = newBackoffLevel ?? backoffLevel;
			conn.routingStatus = "blocked";
			conn.healthStatus = status >= 500 ? "unhealthy" : "degraded";
			conn.quotaState = status === 429 ? "exhausted" : "ok";
			conn.authState = status === 401 || status === 403 ? "invalid" : "ok";
			conn.reasonCode =
				status === 429
					? "quota_exhausted"
					: status === 401 || status === 403
						? "auth_invalid"
						: "usage_request_failed";
			conn.reasonDetail = reason;
			conn.nextRetryAt = rateLimitedUntil;
			conn.resetAt = rateLimitedUntil;
			conn.lastCheckedAt = nowIso;
		},
		env,
	);
	const conn = updated?.providers?.[connectionId];
	if (!conn) return;

	log.warn(
		"ACCOUNT",
		`${connectionId} | unavailable until ${conn.nextRetryAt} (backoff=${conn.backoffLevel || 0})`,
	);
}

async function clearAccountError(
	runtimeId,
	connectionId,
	currentCredentials,
	env,
) {
	// Only update if currently has error status (optimization)
	const hasError =
		(currentCredentials.routingStatus &&
			currentCredentials.routingStatus !== "eligible") ||
		(currentCredentials.quotaState && currentCredentials.quotaState !== "ok") ||
		(currentCredentials.authState && currentCredentials.authState !== "ok") ||
		(currentCredentials.healthStatus &&
			currentCredentials.healthStatus !== "healthy") ||
		(currentCredentials.reasonCode &&
			currentCredentials.reasonCode !== "unknown") ||
		currentCredentials.reasonDetail ||
		currentCredentials.nextRetryAt ||
		currentCredentials.resetAt;

	if (!hasError) return;

	const updated = await updateRuntimeProviderState(
		runtimeId,
		connectionId,
		(conn) => {
			conn.backoffLevel = 0;
			conn.routingStatus = "eligible";
			conn.authState = "ok";
			conn.healthStatus = "healthy";
			conn.quotaState = "ok";
			conn.reasonCode = "unknown";
			conn.reasonDetail = null;
			conn.nextRetryAt = null;
			conn.resetAt = null;
			conn.lastCheckedAt = new Date().toISOString();
		},
		env,
	);
	if (!updated?.providers?.[connectionId]) return;

	log.info("ACCOUNT", `${connectionId} | error cleared`);
}

async function updateCredentials(runtimeId, connectionId, newCredentials, env) {
	const updated = await updateRuntimeProviderCredentials(
		runtimeId,
		connectionId,
		newCredentials,
		env,
	);
	if (!updated?.providers?.[connectionId]) return;

	log.debug("TOKEN", `credentials updated in runtime cache | ${connectionId}`);
}
