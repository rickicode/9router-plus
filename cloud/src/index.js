import { initTranslators } from "open-sse/translator/index.js";
import { ollamaModels } from "open-sse/config/ollamaModels.js";
import { transformToOllama } from "open-sse/utils/ollamaTransform.js";
import * as log from "./utils/logger.js";

// Static imports for handlers (avoid dynamic import CPU cost)
import { handleCleanup } from "./handlers/cleanup.js";
import { handleCacheClear } from "./handlers/cache.js";
import { handleSync } from "./handlers/sync.js";
import { handleChat } from "./handlers/chat.js";
import { handleVerify } from "./handlers/verify.js";
import { handleTestClaude } from "./handlers/testClaude.js";
import { handleForward } from "./handlers/forward.js";
import { handleForwardRaw } from "./handlers/forwardRaw.js";
import { handleEmbeddings } from "./handlers/embeddings.js";
import { handleUsage, handleAdminUsageEvents } from "./handlers/usage.js";
import { handleHealth } from "./handlers/health.js";
import {
  handleAdminHealth,
  handleAdminRegister,
  handleAdminStatusJson,
  handleAdminStatusHtml,
  handleAdminRuntimeRefresh,
  handleAdminUnregister
} from "./handlers/admin.js";
import {
  handleSqliteBackupUpload,
  handleSqliteBackupList,
  handleSqliteBackupDownload,
  handleExportData,
  handleUsageBackup,
  handleRequestLogBackup,
  handleR2Info
} from "./handlers/r2backup.js";
import { createLandingPageResponse } from "./services/landingPage.js";
import { cleanupExpiredSessions, limitUsageMapSize, maybeResetUsageEvents } from "./services/state.js";
import { getRuntimeConfig } from "./services/storage.js";
import { parseApiKey } from "./utils/apiKey.js";
import { recordUsageEvent } from "./services/usage.js";

// Translators will be initialized lazily on first use

let lastMemoryCleanupAt = 0;
const morphRotationCursors = new Map();
const DEFAULT_MORPH_UPSTREAM_TIMEOUT_MS = 25000;
const MORPH_RETRYABLE_STATUS_CODES = new Set([401, 408, 409, 423, 425, 429]);

const DEFAULT_MORPH_MODELS = [
  { id: "morph-v3-large", owned_by: "morph" },
  { id: "morph-v3-fast", owned_by: "morph" },
  { id: "morph-embedding-v4", owned_by: "morph" },
];

function runPeriodicMemoryCleanup() {
  const now = Date.now();
  maybeResetUsageEvents(now);
  if (now - lastMemoryCleanupAt < 60000) return;

  cleanupExpiredSessions();
  limitUsageMapSize(1000);
  lastMemoryCleanupAt = now;
}

function buildMorphModelsResponse() {
  const created = Math.floor(Date.now() / 1000);

  return {
    object: "list",
    data: DEFAULT_MORPH_MODELS.map((model) => ({
      id: model.id,
      object: "model",
      created,
      owned_by: model.owned_by,
      permission: [],
      root: model.id,
      parent: null,
    })),
  };
}

async function resolveMorphMachineId(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const apiKey = authHeader.slice(7);
  const parsed = await parseApiKey(apiKey);
  if (!parsed?.isNewFormat || !parsed.machineId) {
    return null;
  }

  const data = await getRuntimeConfig(parsed.machineId, env);
  if (!data?.apiKeys?.some((entry) => entry.isActive !== false && entry.key === apiKey)) {
    return null;
  }

  return parsed.machineId;
}

function getMorphUpstreamTimeoutMs() {
  const timeoutMs = Number(envOrProcessValue("MORPH_UPSTREAM_TIMEOUT_MS"));
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_MORPH_UPSTREAM_TIMEOUT_MS;
}

function envOrProcessValue(key) {
  try {
    if (typeof process !== "undefined" && process?.env?.[key]) {
      return process.env[key];
    }
  } catch {
    // Ignore environments without process access.
  }
  return undefined;
}

function getMorphApiKeys(morphSettings) {
  return Array.isArray(morphSettings?.apiKeys)
    ? morphSettings.apiKeys.filter((entry) => entry?.key && entry.isActive !== false)
    : [];
}

function isMorphRetryableStatus(status) {
  return MORPH_RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

async function readMorphResponseText(response) {
  if (!response) return "";
  try {
    return await response.clone().text();
  } catch {
    return "";
  }
}

function summarizeMorphFailure(status, responseText, fallbackLabel = "Morph upstream request failed") {
  const normalizedText = typeof responseText === "string" ? responseText.trim() : "";
  const compactText = normalizedText.replace(/\s+/g, " ").slice(0, 240);
  if (compactText) {
    return `${fallbackLabel} (${status}): ${compactText}`;
  }
  return `${fallbackLabel} (${status})`;
}

function createMorphErrorResponse(status, message, retryAfterSeconds = null) {
  const headers = { "Content-Type": "application/json" };
  if (retryAfterSeconds) {
    headers["Retry-After"] = String(retryAfterSeconds);
  }
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function getMorphKeyOrder(machineId, morphSettings) {
  const apiKeys = getMorphApiKeys(morphSettings);
  if (apiKeys.length === 0) {
    return [];
  }

  if (morphSettings?.roundRobinEnabled !== true || apiKeys.length === 1) {
    return apiKeys;
  }

  const currentIndex = morphRotationCursors.get(machineId) || 0;
  const selectedIndex = currentIndex % apiKeys.length;
  morphRotationCursors.set(machineId, (selectedIndex + 1) % apiKeys.length);

  return apiKeys.map((_, offset) => apiKeys[(selectedIndex + offset) % apiKeys.length]);
}

function selectMorphApiKey(machineId, morphSettings) {
  const apiKeys = getMorphKeyOrder(machineId, morphSettings);
  return apiKeys[0]?.key || "";
}

async function getMorphSettingsForRequest(request, env) {
  const machineId = await resolveMorphMachineId(request, env);
  if (!machineId) {
    return { error: new Response(JSON.stringify({ error: "Invalid API key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }) };
  }

  const runtimeConfig = await getRuntimeConfig(machineId, env);
  const morph = runtimeConfig?.settings?.morph;
  if (!morph?.baseUrl || !Array.isArray(morph.apiKeys) || morph.apiKeys.length === 0) {
    return { error: new Response(JSON.stringify({ error: "Morph is not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }) };
  }

  return { machineId, morph };
}

async function handleMorphCapability(request, env, upstreamPath) {
  const startedAt = Date.now();
  const resolved = await getMorphSettingsForRequest(request, env);
  if (resolved.error) {
    return resolved.error;
  }

  const { machineId, morph } = resolved;
  const apiKeys = getMorphKeyOrder(machineId, morph);
  if (apiKeys.length === 0) {
    return new Response(JSON.stringify({ error: "Morph is not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const upstreamUrl = new URL(upstreamPath, `${String(morph.baseUrl).replace(/\/+$/, "")}/`).toString();
  const requestBody = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.text();
  const timeoutMs = getMorphUpstreamTimeoutMs();

  let lastFailureResponse = null;
  let lastFailureMessage = null;

  for (let index = 0; index < apiKeys.length; index += 1) {
    const currentKey = apiKeys[index]?.key;
    if (!currentKey) {
      continue;
    }

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${currentKey}`,
          "Content-Type": request.headers.get("Content-Type") || "application/json",
        },
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (upstreamResponse.ok || index === apiKeys.length - 1 || !isMorphRetryableStatus(upstreamResponse.status)) {
        const responseText = upstreamResponse.ok ? "" : await readMorphResponseText(upstreamResponse);
        recordUsageEvent({
          type: "morph",
          endpoint: new URL(request.url).pathname,
          provider: "morph",
          model: null,
          connectionId: null,
          status: upstreamResponse.status,
          tokensInput: 0,
          tokensOutput: 0,
          error: upstreamResponse.ok ? null : summarizeMorphFailure(upstreamResponse.status, responseText, "Morph upstream rejected request"),
          latencyMs: Date.now() - startedAt,
        });

        if (!upstreamResponse.ok && responseText) {
          return createMorphErrorResponse(
            upstreamResponse.status,
            summarizeMorphFailure(upstreamResponse.status, responseText, "Morph upstream rejected request"),
            upstreamResponse.status === 429 ? 1 : null,
          );
        }

        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: upstreamResponse.headers,
        });
      }

      lastFailureResponse = upstreamResponse;
      lastFailureMessage = summarizeMorphFailure(
        upstreamResponse.status,
        await readMorphResponseText(upstreamResponse),
        "Morph upstream rejected key"
      );
    } catch (error) {
      const isTimeout = error?.name === "AbortError" || error?.name === "TimeoutError" || error?.code === 23;
      lastFailureMessage = isTimeout
        ? `Morph upstream request timed out after ${timeoutMs}ms`
        : `Morph upstream request failed: ${error?.message || "unknown error"}`;

      if (index === apiKeys.length - 1) {
        recordUsageEvent({
          type: "morph",
          endpoint: new URL(request.url).pathname,
          provider: "morph",
          model: null,
          connectionId: null,
          status: 504,
          tokensInput: 0,
          tokensOutput: 0,
          error: lastFailureMessage,
          latencyMs: Date.now() - startedAt,
        });
        return createMorphErrorResponse(isTimeout ? 504 : 502, lastFailureMessage, isTimeout ? 1 : null);
      }

      continue;
    }
  }

  const fallbackStatus = lastFailureResponse?.status || 503;
  const fallbackMessage = lastFailureMessage || "Morph upstream request failed";
  recordUsageEvent({
    type: "morph",
    endpoint: new URL(request.url).pathname,
    provider: "morph",
    model: null,
    connectionId: null,
    status: fallbackStatus,
    tokensInput: 0,
    tokensOutput: 0,
    error: fallbackMessage,
    latencyMs: Date.now() - startedAt,
  });
  return createMorphErrorResponse(fallbackStatus, fallbackMessage, fallbackStatus === 429 ? 1 : null);
}

// Helper to add CORS headers to response
function addCorsHeaders(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  newHeaders.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

const worker = {
  async scheduled(event, env, ctx) {
    runPeriodicMemoryCleanup();
    const result = await handleCleanup(env);
    log.info("SCHEDULED", "Cleanup completed", result);
  },

  async fetch(request, env, ctx) {
    runPeriodicMemoryCleanup();
    const startTime = Date.now();
    const url = new URL(request.url);
    let path = url.pathname;

    // Normalize /v1/v1/* → /v1/*
    if (path.startsWith("/v1/v1/")) {
      path = path.replace("/v1/v1/", "/v1/");
    } else if (path === "/v1/v1") {
      path = "/v1";
    }

    log.request(request.method, path);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "*"
        }
      });
    }

    try {
      // Routes
      
      // Landing page
      if (path === "/" && request.method === "GET") {
        const response = createLandingPageResponse();
        log.response(response.status, Date.now() - startTime);
        return response;
      }

      if (path === "/health" && request.method === "GET") {
        log.response(200, Date.now() - startTime);
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      // Admin endpoints (secret-protected, except /admin/health which is public)
      if (path === "/admin/health" && request.method === "GET") {
        const response = handleAdminHealth();
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/admin/register" && request.method === "POST") {
        const response = await handleAdminRegister(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/admin/status.json" && request.method === "GET") {
        const response = await handleAdminStatusJson(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/admin/status" && request.method === "GET") {
        const response = await handleAdminStatusHtml(request, env);
        log.response(response.status, Date.now() - startTime);
        return response;
      }

      if (path === "/admin/runtime/refresh" && request.method === "POST") {
        const response = await handleAdminRuntimeRefresh(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/admin/unregister" && request.method === "POST") {
        const response = await handleAdminUnregister(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/admin/usage/events" && request.method === "GET") {
        const response = await handleAdminUsageEvents(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // Ollama compatible - list models
      if (path === "/api/tags" && request.method === "GET") {
        log.response(200, Date.now() - startTime);
        return new Response(JSON.stringify(ollamaModels), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/cache/clear" && request.method === "POST") {
        const response = await handleCacheClear(request, env);
        log.response(response.status, Date.now() - startTime);
        return response;
      }

      // Sync provider data by machineId (GET, POST, DELETE)
      if (path.startsWith("/sync/") && ["GET", "POST", "DELETE"].includes(request.method)) {
        const response = await handleSync(request, env, ctx);
        log.response(response.status, Date.now() - startTime);
        return response;
      }

      // ========== NEW FORMAT: /v1/... (machineId in API key) ==========
      
      // New format: /v1/chat/completions
      if (path === "/v1/chat/completions" && request.method === "POST") {
        const response = await handleChat(request, env, ctx, null);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // New format: /v1/messages (Claude format)
      if (path === "/v1/messages" && request.method === "POST") {
        const response = await handleChat(request, env, ctx, null);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // New format: /v1/embeddings
      if (path === "/v1/embeddings" && request.method === "POST") {
        const response = await handleEmbeddings(request, env, ctx, null);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // New format: /v1/responses (OpenAI Responses API - Codex CLI)
      if (path === "/v1/responses" && request.method === "POST") {
        const response = await handleChat(request, env, ctx, null);
        log.response(response.status, Date.now() - startTime);
        return response;
      }

      if (path === "/morphllm/v1/chat/completions" && request.method === "POST") {
        const response = await handleMorphCapability(request, env, "/v1/chat/completions");
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/morphllm/v1/compact" && request.method === "POST") {
        const response = await handleMorphCapability(request, env, "/v1/compact");
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/morphllm/v1/embeddings" && request.method === "POST") {
        const response = await handleMorphCapability(request, env, "/v1/embeddings");
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/morphllm/v1/rerank" && request.method === "POST") {
        const response = await handleMorphCapability(request, env, "/v1/rerank");
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/morphllm/v1/models" && request.method === "GET") {
        const resolved = await getMorphSettingsForRequest(request, env);
        const response = resolved.error
          ? resolved.error
          : Response.json(buildMorphModelsResponse(), {
              headers: { "Access-Control-Allow-Origin": "*" },
            });
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/morphllm/chat/completions" && request.method === "POST") {
        const response = await handleMorphCapability(request, env, "/v1/chat/completions");
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/morphllm/compact" && request.method === "POST") {
        const response = await handleMorphCapability(request, env, "/v1/compact");
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/morphllm/embeddings" && request.method === "POST") {
        const response = await handleMorphCapability(request, env, "/v1/embeddings");
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/morphllm/rerank" && request.method === "POST") {
        const response = await handleMorphCapability(request, env, "/v1/rerank");
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      if (path === "/morphllm/models" && request.method === "GET") {
        const resolved = await getMorphSettingsForRequest(request, env);
        const response = resolved.error
          ? resolved.error
          : Response.json(buildMorphModelsResponse(), {
              headers: { "Access-Control-Allow-Origin": "*" },
            });
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // New format: /v1/verify
      if (path === "/v1/verify" && request.method === "GET") {
        const response = await handleVerify(request, env, null);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // New format: /worker/usage
      if (path === "/worker/usage" && request.method === "GET") {
        const response = await handleUsage(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // New format: /worker/health
      if (path === "/worker/health" && request.method === "GET") {
        const response = await handleHealth(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // New format: /v1/api/chat (Ollama format)
      if (path === "/v1/api/chat" && request.method === "POST") {
        const clonedReq = request.clone();
        const body = await clonedReq.json();
        const response = await handleChat(request, env, ctx, null);
        const ollamaResponse = transformToOllama(response, body.model || "llama3.2");
        log.response(200, Date.now() - startTime);
        return ollamaResponse;
      }

      // ========== OLD FORMAT: /{machineId}/v1/... ==========

      // Machine ID based chat endpoint
      if (path.match(/^\/[^\/]+\/v1\/chat\/completions$/) && request.method === "POST") {
        const machineId = path.split("/")[1];
        const response = await handleChat(request, env, ctx, machineId);
        log.response(response.status, Date.now() - startTime);
        return response;
      }

      // Machine ID based embeddings endpoint
      if (path.match(/^\/[^\/]+\/v1\/embeddings$/) && request.method === "POST") {
        const machineId = path.split("/")[1];
        const response = await handleEmbeddings(request, env, ctx, machineId);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // Machine ID based messages endpoint (Claude format)
      if (path.match(/^\/[^\/]+\/v1\/messages$/) && request.method === "POST") {
        const machineId = path.split("/")[1];
        const response = await handleChat(request, env, ctx, machineId);
        log.response(response.status, Date.now() - startTime);
        return response;
      }

      // Machine ID based api/chat endpoint (Ollama format)
      if (path.match(/^\/[^\/]+\/v1\/api\/chat$/) && request.method === "POST") {
        const machineId = path.split("/")[1];
        const clonedReq = request.clone();
        const body = await clonedReq.json();
        const response = await handleChat(request, env, ctx, machineId);
        const ollamaResponse = transformToOllama(response, body.model || "llama3.2");
        log.response(200, Date.now() - startTime);
        return ollamaResponse;
      }

      // Machine ID based verify endpoint
      if (path.match(/^\/[^\/]+\/v1\/verify$/) && request.method === "GET") {
        const machineId = path.split("/")[1];
        const response = await handleVerify(request, env, machineId);
        log.response(response.status, Date.now() - startTime);
        return response;
      }

      // Test Claude - forward to Anthropic API
      if (path === "/testClaude" && request.method === "POST") {
        const response = await handleTestClaude(request);
        log.response(response.status, Date.now() - startTime);
        return response;
      }

      // Forward request to any endpoint
      if (path === "/forward" && request.method === "POST") {
        const response = await handleForward(request);
        log.response(response.status, Date.now() - startTime);
        return response;
      }

      // Forward request via raw TCP socket (bypasses CF auto headers)
      if (path === "/forward-raw" && request.method === "POST") {
        const response = await handleForwardRaw(request);
        log.response(response.status, Date.now() - startTime);
        return response;
      }

      // ========== R2 BACKUP/RESTORE ENDPOINTS ==========

      // R2 info (storage status)
      if (path === "/r2/info" && request.method === "GET") {
        const response = await handleR2Info(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // SQLite backup upload
      if (path.match(/^\/r2\/backup\/sqlite\/[^/]+$/) && request.method === "POST") {
        const response = await handleSqliteBackupUpload(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // SQLite backup list
      if (path === "/r2/backup/sqlite" && request.method === "GET") {
        const response = await handleSqliteBackupList(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // SQLite backup download
      if (path === "/r2/backup/sqlite/download" && request.method === "GET") {
        const response = await handleSqliteBackupDownload(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // Export all data for restore/rollback
      if (path.match(/^\/r2\/export\/[^/]+$/) && request.method === "GET") {
        const response = await handleExportData(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // Usage data backup
      if (path.match(/^\/r2\/usage\/[^/]+$/) && request.method === "POST") {
        const response = await handleUsageBackup(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      // Request log backup
      if (path.match(/^\/r2\/requests\/[^/]+$/) && request.method === "POST") {
        const response = await handleRequestLogBackup(request, env);
        log.response(response.status, Date.now() - startTime);
        return addCorsHeaders(response);
      }

      log.warn("ROUTER", "Not found", { path });
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });

    } catch (error) {
      log.error("ROUTER", error.message, { stack: error.stack });
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};

export default worker;
