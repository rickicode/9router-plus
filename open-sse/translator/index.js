import { FORMATS } from "./formats.js";
import { ensureToolCallIds, fixMissingToolResponses } from "./helpers/toolCallHelper.js";
import { prepareClaudeRequest } from "./helpers/claudeHelper.js";
import { cloakClaudeTools } from "../utils/claudeCloaking.js";
import { filterToOpenAIFormat } from "./helpers/openaiHelper.js";
import { normalizeThinkingConfig } from "../services/provider.js";
import { AntigravityExecutor } from "../executors/antigravity.js";
import { normalizeOpenAIResponsesInPlace } from "./helpers/responsesApiHelper.js";

// Registry for translators
const requestRegistry = new Map();
const responseRegistry = new Map();

// Initialization state machine: 'idle' | 'loading' | 'ready' | 'error'
let translatorInitState = "idle";
let translatorInitError = null;

// Register translator
export function register(from, to, requestFn, responseFn) {
  const key = `${from}:${to}`;
  if (requestFn) {
    requestRegistry.set(key, requestFn);
  }
  if (responseFn) {
    responseRegistry.set(key, responseFn);
  }
}

// Lazy load translators (called once on first use)
// Thread-safe: atomic state machine prevents double initialization
async function ensureInitialized() {
  // Fast path: already initialized
  if (translatorInitState === "ready") return;

  // Wait if initialization is currently in progress
  if (translatorInitState === "loading") {
    while (translatorInitState === "loading") {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    if (translatorInitState === "ready") return;
    if (translatorInitState === "error") throw translatorInitError;
  }

  // Start initialization with an atomic state transition
  if (translatorInitState !== "idle") return;
  translatorInitState = "loading";

  try {
    await Promise.race([
      Promise.all([
        import("./request/claude-to-openai.js"),
        import("./request/openai-to-claude.js"),
        import("./request/gemini-to-openai.js"),
        import("./request/openai-to-gemini.js"),
        import("./request/openai-to-vertex.js"),
        import("./request/antigravity-to-openai.js"),
        import("./request/openai-responses.js"),
        import("./request/openai-to-kiro.js"),
        import("./request/openai-to-cursor.js"),
        import("./request/openai-to-ollama.js"),
        // Response translators
        import("./response/claude-to-openai.js"),
        import("./response/openai-to-claude.js"),
        import("./response/gemini-to-openai.js"),
        import("./response/openai-to-antigravity.js"),
        import("./response/openai-responses.js"),
        import("./response/kiro-to-openai.js"),
        import("./response/cursor-to-openai.js"),
        import("./response/ollama-to-openai.js")
      ]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Translator initialization timeout (30s)")), 30000)
      )
    ]);

    translatorInitState = "ready";
    translatorInitError = null;
  } catch (error) {
    const wrappedError = new Error(`Failed to initialize translators: ${error.message}`);
    console.error("[Translator] Initialization failed:", error);
    translatorInitState = "error";
    translatorInitError = wrappedError;
    throw wrappedError;
  }
}

// Strip specific content types from messages (explicit opt-in via strip[] in PROVIDER_MODELS)
function stripContentTypes(body, stripList = []) {
  if (!stripList.length || !body.messages || !Array.isArray(body.messages)) return;
  const imageTypes = new Set(["image_url", "image"]);
  const audioTypes = new Set(["audio_url", "input_audio"]);
  const shouldStrip = (type) => {
    if (imageTypes.has(type)) return stripList.includes("image");
    if (audioTypes.has(type)) return stripList.includes("audio");
    return false;
  };
  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.filter(part => !shouldStrip(part.type));
    if (msg.content.length === 0) msg.content = "";
  }
}

// Translate request: source -> openai -> target
export async function translateRequest(sourceFormat, targetFormat, model, body, stream = true, credentials = null, provider = null, reqLogger = null, stripList = [], connectionId = null) {
  await ensureInitialized();
  let result = body;

  // Strip explicit content types (opt-in via strip[] in PROVIDER_MODELS entry)
  stripContentTypes(result, stripList);

  // Normalize thinking config: remove if lastMessage is not user
  normalizeThinkingConfig(result);

  // Always ensure tool_calls have id (some providers require it)
  ensureToolCallIds(result);
  
  // Fix missing tool responses (insert empty tool_result if needed)
  fixMissingToolResponses(result);

  // Some providers and clients both speak Responses API, but clipboard/image
  // payloads still need request-side normalization before forwarding upstream.
  // Previously this was implemented as a `responses → openai → responses`
  // round-trip; now it's an in-place normalizer that applies the same
  // image-shape normalization, role coercion, default-injection and
  // field-drop contract without materializing the chat-completions
  // intermediate. When request logging is on, we still surface the
  // intermediate via the legacy round-trip for log fidelity.
  if (sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES) {
    if (reqLogger?.logOpenAIRequest) {
      const normalizeResponsesRequest = requestRegistry.get(`${FORMATS.OPENAI_RESPONSES}:${FORMATS.OPENAI}`);
      const restoreResponsesRequest = requestRegistry.get(`${FORMATS.OPENAI}:${FORMATS.OPENAI_RESPONSES}`);

      if (normalizeResponsesRequest && restoreResponsesRequest) {
        result = normalizeResponsesRequest(model, result, stream, credentials);
        reqLogger.logOpenAIRequest(result);
        result = restoreResponsesRequest(model, result, stream, credentials);
      }
    } else {
      result = normalizeOpenAIResponsesInPlace(model, result, stream);
    }
  }

  // If same format, skip translation steps
  if (sourceFormat !== targetFormat) {
    // Step 1: source -> openai (if source is not openai)
    if (sourceFormat !== FORMATS.OPENAI) {
      const toOpenAI = requestRegistry.get(`${sourceFormat}:${FORMATS.OPENAI}`);
      if (toOpenAI) {
        result = toOpenAI(model, result, stream, credentials);
        // Log OpenAI intermediate format
        reqLogger?.logOpenAIRequest?.(result);
      }
    }

    // Step 2: openai -> target (if target is not openai)
    if (targetFormat !== FORMATS.OPENAI) {
      const fromOpenAI = requestRegistry.get(`${FORMATS.OPENAI}:${targetFormat}`);
      if (fromOpenAI) {
        result = fromOpenAI(model, result, stream, credentials);
      }
    }
  }

  // Always normalize to clean OpenAI format when target is OpenAI
  // This handles hybrid requests (e.g., OpenAI messages + Claude tools)
  if (targetFormat === FORMATS.OPENAI) {
    result = filterToOpenAIFormat(result);
  }

  // Final step: prepare request for Claude format endpoints
  if (targetFormat === FORMATS.CLAUDE) {
    const apiKey = credentials?.accessToken || credentials?.apiKey || null;
    result = prepareClaudeRequest(result, provider, apiKey, connectionId);
  }

  // Claude cloaking: rename client tools with _cc suffix (anti-ban)
  // Only for claude provider (not anthropic-compatible-*) with OAuth token
  if (provider === "claude") {
    const apiKey = credentials?.accessToken || credentials?.apiKey || null;
    if (apiKey?.includes("sk-ant-oat")) {
      const { body: cloakedBody, toolNameMap } = cloakClaudeTools(result);
      result = cloakedBody;
      if (toolNameMap?.size > 0) {
        result._toolNameMap = toolNameMap;
      }
    }
  }

  // Antigravity cloaking: rename client tools + inject decoys (anti-ban)
  // Skip if client is native AG (userAgent = antigravity)
  if (provider === FORMATS.ANTIGRAVITY && body.userAgent !== FORMATS.ANTIGRAVITY) {
    const { cloakedBody, toolNameMap } = AntigravityExecutor.cloakTools(result);
    result = cloakedBody;
    if (toolNameMap?.size > 0) {
      result._toolNameMap = toolNameMap;
    }
  }

  return result;
}

// Translate response chunk: target -> openai -> source
export async function translateResponse(targetFormat, sourceFormat, chunk, state) {
  await ensureInitialized();
  // Null chunk is a flush signal; same-format passthrough should not emit a synthetic payload.
  if (chunk == null && sourceFormat === targetFormat) {
    return [];
  }
  // If same format, return as-is
  if (sourceFormat === targetFormat) {
    return [chunk];
  }

  let results = [chunk];
  let openaiResults = null; // Store OpenAI intermediate results

  // Step 1: target -> openai (if target is not openai)
  if (targetFormat !== FORMATS.OPENAI) {
    const toOpenAI = responseRegistry.get(`${targetFormat}:${FORMATS.OPENAI}`);
    if (toOpenAI) {
      results = [];
      const converted = toOpenAI(chunk, state);
      if (converted) {
        results = Array.isArray(converted) ? converted : [converted];
        openaiResults = results; // Store OpenAI intermediate
      }
    }
  }

  // Step 2: openai -> source (if source is not openai)
  if (sourceFormat !== FORMATS.OPENAI) {
    const fromOpenAI = responseRegistry.get(`${FORMATS.OPENAI}:${sourceFormat}`);
    if (fromOpenAI) {
      const finalResults = [];
      for (const r of results) {
        const converted = fromOpenAI(r, state);
        if (converted) {
          finalResults.push(...(Array.isArray(converted) ? converted : [converted]));
        }
      }
      results = finalResults;
    }
  }

  // Attach OpenAI intermediate results for logging
  if (openaiResults && sourceFormat !== FORMATS.OPENAI && targetFormat !== FORMATS.OPENAI) {
    results._openaiIntermediate = openaiResults;
  }

  return results;
}

// Check if translation needed
export function needsTranslation(sourceFormat, targetFormat) {
  return sourceFormat !== targetFormat;
}

// Initialize state for streaming response based on format
export function initState(sourceFormat) {
  // Base state for all formats
  const base = {
    messageId: null,
    model: null,
    textBlockStarted: false,
    thinkingBlockStarted: false,
    inThinkingBlock: false,
    currentBlockIndex: null,
    toolCalls: new Map(),
    finishReason: null,
    finishReasonSent: false,
    usage: null,
    contentBlockIndex: -1
  };

  // Add openai-responses specific fields
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    return {
      ...base,
      seq: 0,
      responseId: `resp_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      started: false,
      msgTextBuf: {},
      msgItemAdded: {},
      msgContentAdded: {},
      msgItemDone: {},
      reasoningId: "",
      reasoningIndex: -1,
      reasoningBuf: "",
      reasoningPartAdded: false,
      reasoningDone: false,
      inThinking: false,
      funcArgsBuf: {},
      funcNames: {},
      funcCallIds: {},
      funcArgsDone: {},
      funcItemDone: {},
      completedOutputItems: [],
      completedSent: false
    };
  }

  return base;
}

// Initialize all translators (kept for backward compatibility)
export async function initTranslators() {
  await ensureInitialized();
}
