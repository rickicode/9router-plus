import { createHash } from "crypto";
import { BaseExecutor } from "./base.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { PROVIDERS } from "../config/providers.js";
import { normalizeResponsesInput } from "../translator/helpers/responsesApiHelper.js";
import { fetchImageAsBase64 } from "../translator/helpers/imageHelper.js";
import { getConsistentMachineId } from "../../src/shared/utils/machineId.js";

// In-memory map: hash(machineId + first assistant content) → { sessionId, lastUsed }
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const assistantSessionMap = new Map();
let sessionCleanupInterval = null;

// Cache machine ID at module level (resolved once)
let cachedMachineId = null;
let machineIdPromise = null;

async function ensureMachineId() {
  if (cachedMachineId) return cachedMachineId;
  if (!machineIdPromise) {
    machineIdPromise = getConsistentMachineId()
      .then((id) => {
        cachedMachineId = id;
        return id;
      })
      .catch(() => null);
  }
  return machineIdPromise;
}

function ensureSessionCleanupInterval() {
  if (sessionCleanupInterval) return;
  sessionCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of assistantSessionMap) {
      if (now - entry.lastUsed > SESSION_TTL_MS) assistantSessionMap.delete(key);
    }
  }, 10 * 60 * 1000);
  sessionCleanupInterval.unref?.();
}

function hashContent(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function generateSessionId() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// Mirror of CLIProxyAPI's ensureImageGenerationTool. Adds the image_generation
// tool to body.tools (creating the array if absent) so the Codex backend
// enables multimodal input (input_image / input_file) on the request.
//
// Skipped for "spark" models and Codex free-plan accounts, matching upstream.
function isCodexFreePlanCredentials(credentials) {
  if (!credentials || typeof credentials !== "object") return false;
  const candidates = [
    credentials.plan_type,
    credentials.planType,
    credentials.plan,
    credentials?.attributes?.plan_type,
    credentials?.attributes?.planType,
    credentials?.attributes?.plan,
    credentials?.account?.plan_type,
    credentials?.account?.planType,
    credentials?.account?.plan,
  ];
  return candidates.some((v) => typeof v === "string" && v.trim().toLowerCase() === "free");
}

function ensureImageGenerationTool(body, baseModel, credentials) {
  if (!body || typeof body !== "object") return body;
  const modelName = typeof baseModel === "string" ? baseModel : "";
  if (modelName.endsWith("spark")) return body;
  if (isCodexFreePlanCredentials(credentials)) return body;

  const tool = { type: "image_generation", output_format: "png" };
  if (!Array.isArray(body.tools)) {
    body.tools = [tool];
    return body;
  }
  for (const t of body.tools) {
    if (t && typeof t === "object" && t.type === "image_generation") return body;
  }
  body.tools.push(tool);
  return body;
}

// Extract text content from an input item
function extractItemText(item) {
  if (!item) return "";
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map(c => c.text || c.output || "").filter(Boolean).join("");
  }
  return "";
}

// Resolve session_id from first assistant message + machineId to avoid cross-user collision
function resolveConversationSessionId(input, machineId) {
  const machineSessionId = machineId ? `sess_${hashContent(machineId)}` : generateSessionId();
  if (!Array.isArray(input) || input.length === 0) return machineSessionId;

  // Find first assistant message that has actual text content
  let text = "";
  for (const item of input) {
    if (item.role === "assistant") {
      text = extractItemText(item);
      if (text) break;
    }
  }
  if (!text) return machineSessionId;

  const hash = hashContent((machineId || "") + text);
  const entry = assistantSessionMap.get(hash);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.sessionId;
  }


  const sessionId = generateSessionId();
  assistantSessionMap.set(hash, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

/**
 * Codex Executor - handles OpenAI Codex API (Responses API format)
 * Automatically injects default instructions if missing
 */
export class CodexExecutor extends BaseExecutor {
  constructor() {
    super("codex", PROVIDERS.codex);
    this._currentSessionId = null;
  }

  /**
   * Override headers to add session_id per conversation
   * transformRequest runs BEFORE buildHeaders, sets this._currentSessionId
   */
  buildHeaders(credentials, stream = true) {
    const headers = super.buildHeaders(credentials, stream);
    headers["session_id"] = this._currentSessionId || credentials?.connectionId || "default";
    return headers;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const base = super.buildUrl(model, stream, urlIndex, credentials);
    return this._isCompact ? `${base}/compact` : base;
  }

  /**
   * Inline image content for Codex backend, which cannot fetch remote URLs and
   * expects images encoded as data: URIs.
   *
   * Handles every shape that can reach this executor after request translation:
   *   - Chat Completions style: { type: "image_url", image_url: { url, detail } | "<url>" }
   *   - Responses style:        { type: "input_image", image_url: "<url>" | { url } }
   *   - File-style image:       { type: "input_file", file_data: "...", mime_type: "image/*" }
   *
   * Runs before transformRequest() and mutates body.input in place.
   */
  async prefetchImages(body) {
    if (!Array.isArray(body?.input)) return;
    for (const item of body.input) {
      if (!Array.isArray(item.content)) continue;
      const pending = item.content.map((c) => this._normalizeContentPart(c));
      item.content = await Promise.all(pending);
    }
  }

  async _normalizeContentPart(c) {
    if (!c || typeof c !== "object") return c;

    // Chat Completions native image block.
    if (c.type === "image_url") {
      const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
      const detail = (typeof c.image_url === "object" && c.image_url?.detail) || c.detail || "auto";
      if (!url) return c;
      if (url.startsWith("data:")) return { type: "input_image", image_url: url, detail };
      if (/^https?:/i.test(url)) {
        const fetched = await fetchImageAsBase64(url, { timeoutMs: 15000 });
        return { type: "input_image", image_url: fetched?.url || url, detail };
      }
      return { type: "input_image", image_url: url, detail };
    }

    // Responses-style image block — may carry remote URL that we still need to inline.
    if (c.type === "input_image") {
      const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url || "";
      const detail = c.detail || (typeof c.image_url === "object" && c.image_url?.detail) || "auto";
      if (url && !url.startsWith("data:") && /^https?:/i.test(url)) {
        const fetched = await fetchImageAsBase64(url, { timeoutMs: 15000 });
        return { type: "input_image", image_url: fetched?.url || url, detail };
      }
      // Normalize image_url to a plain string so downstream JSON.stringify matches Codex schema.
      if (url) return { type: "input_image", image_url: url, detail };
      return c;
    }

    // File-style image block (OpenCode @ai-sdk/openai-compatible can emit these for clipboard images).
    if (c.type === "input_file") {
      const fileData = typeof c.file_data === "string" ? c.file_data : "";
      const mime = typeof c.mime_type === "string" ? c.mime_type : "";
      const detail = c.detail || "auto";
      if (fileData.startsWith("data:image/")) {
        return { type: "input_image", image_url: fileData, detail };
      }
      if (fileData && mime.startsWith("image/")) {
        return { type: "input_image", image_url: `data:${mime};base64,${fileData}`, detail };
      }
      return c;
    }

    return c;
  }

  async execute(args) {
    ensureSessionCleanupInterval();
    cachedMachineId = await ensureMachineId();
    // Fetch remote images before the synchronous transform/execute pipeline
    await this.prefetchImages(args.body);
    return super.execute(args);
  }

  /**
   * Transform request before sending - inject default instructions if missing.
   * Image fetching is handled separately in prefetchImages() so this stays sync.
   */
  transformRequest(model, body, stream, credentials) {
    this._isCompact = !!body._compact;
    delete body._compact;
    // Resolve conversation-stable session_id from input history + machineId
    this._currentSessionId = resolveConversationSessionId(body.input, cachedMachineId);
    // Convert string input to array format (Codex API requires input as array)
    const normalized = normalizeResponsesInput(body.input);
    if (normalized) body.input = normalized;

    // Ensure input is present and non-empty (Codex API rejects empty input)
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }

    // Ensure streaming is enabled (Codex API requires it)
    body.stream = true;

    // If no instructions provided, inject default Codex instructions
    if (!body.instructions || body.instructions.trim() === "") {
      body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
    }

    // Ensure store is false (Codex requirement)
    body.store = false;

    // Extract thinking level from model name suffix
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
    const effortLevels = ['none', 'low', 'medium', 'high', 'xhigh'];
    let modelEffort = null;
    for (const level of effortLevels) {
      if (model.endsWith(`-${level}`)) {
        modelEffort = level;
        // Strip suffix from model name for actual API call
        body.model = body.model.replace(`-${level}`, '');
        break;
      }
    }

    // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default (medium)
    if (!body.reasoning) {
      const effort = body.reasoning_effort || modelEffort || 'low';
      body.reasoning = { effort, summary: "auto" };
    } else if (!body.reasoning.summary) {
      body.reasoning.summary = "auto";
    }
    delete body.reasoning_effort;

    // Include reasoning encrypted content (required by Codex backend for reasoning models)
    if (body.reasoning && body.reasoning.effort && body.reasoning.effort !== 'none') {
      body.include = ["reasoning.encrypted_content"];
    }

    // Remove unsupported parameters for Codex API
    delete body.temperature;
    delete body.top_p;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.n;
    delete body.seed;
    delete body.max_tokens;
    delete body.user; // Cursor sends this but Codex doesn't support it
    delete body.prompt_cache_retention; // Cursor sends this but Codex doesn't support it
    delete body.metadata; // Cursor sends this but Codex doesn't support it
    delete body.stream_options; // Cursor sends this but Codex doesn't support it
    delete body.safety_identifier; // Droid CLI sends this but Codex doesn't support it
    delete body.previous_response_id; // Stateless mode — Codex backend does not retain conversation state

    // Ensure the image_generation tool is registered on the request. The Codex
    // backend gates multimodal *input* (input_image / input_file) behind this
    // tool being present in the tools array; without it, vision is disabled
    // and the model replies "I don't support image input" even if the user
    // sent a clipboard image. CLIProxyAPI does the same in
    // internal/runtime/executor/codex_executor.go::ensureImageGenerationTool.
    ensureImageGenerationTool(body, body.model || model, credentials);

    return body;
  }
}
