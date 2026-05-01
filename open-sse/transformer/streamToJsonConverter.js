/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming.
 */

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
const EMPTY_MESSAGE_ITEM = { type: "message", content: [], role: "assistant" };

function cloneJsonValue(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed") {
    state.status = "completed";
    state.completedOutput = cloneJsonValue(parsed.response?.output, null);
    if (parsed.response?.usage) {
      state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
      state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
      state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
  }
}

function buildOutputFromState(state) {
  if (Array.isArray(state.completedOutput) && state.completedOutput.length > 0) {
    return state.completedOutput;
  }

  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  const output = [];
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || EMPTY_MESSAGE_ITEM);
  }
  return output;
}

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_RESPONSE },
    items: new Map(),
    completedOutput: null,
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    output: buildOutputFromState(state),
    usage: state.usage
  };
}
