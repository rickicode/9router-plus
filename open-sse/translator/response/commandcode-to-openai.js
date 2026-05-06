/**
 * Command Code SSE → OpenAI streaming response translator.
 *
 * Command Code emits custom SSE events:
 *   start      → session start metadata
 *   text-start → beginning of a text block
 *   text-delta → content chunk
 *   text-end   → end of text block
 *   thinking   → reasoning content
 *   tool_use   → tool call block
 *   finish     → stop reason + usage
 *
 * This translator converts them into OpenAI-compatible streaming chunks
 * (chat.completion.chunk with delta.content, delta.reasoning_content,
 *  delta.tool_calls, and final [DONE]).
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";

function getCommandCodeToolId(chunk) {
  return chunk?.tool_use?.id || chunk?.toolCallId || chunk?.id || `call_${Date.now()}`;
}

function getToolCallIndex(state, toolCall) {
  const toolId = toolCall?.id || `call_${Date.now()}`;
  if (!state.commandcodeToolIndexes) state.commandcodeToolIndexes = new Map();
  if (!state.commandcodeToolIndexes.has(toolId)) {
    state.commandcodeToolIndexes.set(toolId, state.commandcodeToolIndexes.size);
  }
  return state.commandcodeToolIndexes.get(toolId);
}

function tryParsePseudoToolCalls(text) {
  if (typeof text !== "string" || !text.includes("<tool_call")) return [];

  const calls = [];
  const callRegex = /<tool_call\s+name="([^"]+)">([\s\S]*?)<\/tool_call>/g;
  let callMatch;
  while ((callMatch = callRegex.exec(text))) {
    const [, name, body] = callMatch;
    const params = {};
    const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(body))) {
      const [, key, rawValue] = paramMatch;
      const trimmed = rawValue.trim();
      if (!trimmed) {
        params[key] = "";
        continue;
      }
      try {
        params[key] = JSON.parse(trimmed);
      } catch {
        params[key] = trimmed;
      }
    }

    calls.push({
      id: `call_${Date.now()}_${calls.length}`,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(params),
      },
    });
  }

  return calls;
}

function getResponseBlocks(chunk) {
  const response = chunk?.response || chunk?.message || null;
  if (!response) return [];
  if (Array.isArray(response.content)) return response.content;
  if (Array.isArray(response.output)) {
    return response.output.flatMap((item) => Array.isArray(item?.content) ? item.content : []);
  }
  return [];
}

function buildChunksFromResponseBlocks(chunk, state) {
  const blocks = getResponseBlocks(chunk);
  const chunks = [];

  if (!state.commandcodeResponseBlockCache) {
    state.commandcodeResponseBlockCache = new Set();
  }

  for (const [index, block] of blocks.entries()) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      const cacheKey = `text:${index}:${block.text}`;
      if (state.commandcodeResponseBlockCache.has(cacheKey)) continue;
      state.commandcodeResponseBlockCache.add(cacheKey);
      chunks.push({
        id: state.messageId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{ index: 0, delta: { content: block.text } }],
      });
      continue;
    }

    if (block?.type === "tool_use") {
      const cacheKey = `tool:${index}:${block.id || ""}:${block.name || ""}:${JSON.stringify(block.input || {})}`;
      if (state.commandcodeResponseBlockCache.has(cacheKey)) continue;
      state.commandcodeResponseBlockCache.add(cacheKey);
      chunks.push({
        id: state.messageId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: getToolCallIndex(state, { id: block.id }),
              id: block.id || `call_${Date.now()}`,
              type: "function",
              function: {
                name: block.name || "",
                arguments: JSON.stringify(block.input || {}),
              },
            }],
          },
        }],
      });
    }
  }

  return chunks;
}

function commandcodeToOpenAI(chunk, state) {
  if (!chunk) return [];

  const event = chunk.type;
  const results = [];

  switch (event) {
    case "start": {
      if (!state.messageId || !state.commandcodeStarted) {
        state.messageId = chunk.id || `chatcmpl-${Date.now()}`;
        state.model = chunk.model || state.model;
        state.commandcodeStarted = true;
        state.commandcodePseudoTextBuffer = "";
        state.commandcodePseudoToolCalls = [];
        results.push({
          id: state.messageId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
        });
      }
      break;
    }
    case "text-start":
      state.inTextBlock = true;
      break;
    case "text-delta": {
      const content = typeof chunk.text === "string" ? chunk.text : "";
      if (content) {
        state.commandcodePseudoTextBuffer = (state.commandcodePseudoTextBuffer || "") + content;
        results.push({
          id: state.messageId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{ index: 0, delta: { content } }],
        });
      }
      break;
    }
    case "text-end": {
      state.inTextBlock = false;
      const pseudoToolCalls = tryParsePseudoToolCalls(state.commandcodePseudoTextBuffer || "");
      if (pseudoToolCalls.length > 0) {
        state.commandcodePseudoToolCalls = pseudoToolCalls;
        state.finishReason = "tool_calls";
      }
      state.commandcodePseudoTextBuffer = "";
      break;
    }
    case "thinking": {
      const thinking = typeof chunk.thinking === "string" ? chunk.thinking : "";
      if (thinking) {
        results.push({
          id: state.messageId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{ index: 0, delta: { reasoning_content: thinking } }],
        });
      }
      break;
    }
    case "tool-input-delta": {
      const toolCallId = getCommandCodeToolId(chunk);
      if (!state.commandcodeToolArgBuffer) state.commandcodeToolArgBuffer = new Map();
      const prev = state.commandcodeToolArgBuffer.get(toolCallId) || "";
      state.commandcodeToolArgBuffer.set(toolCallId, prev + (typeof chunk.delta === "string" ? chunk.delta : ""));
      break;
    }
    case "tool_use": {
      if (chunk.tool_use) {
        const toolCall = chunk.tool_use;
        const toolCallId = getCommandCodeToolId(chunk);
        results.push({
          id: state.messageId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: getToolCallIndex(state, toolCall),
                id: toolCallId,
                type: "function",
                function: {
                  name: toolCall.name || "",
                  arguments: toolCall.input ? JSON.stringify(toolCall.input) : "",
                },
              }],
            },
          }],
        });
      }
      break;
    }
    case "tool-call": {
      const toolCallId = getCommandCodeToolId(chunk);
      const name = chunk.toolName || chunk.name || "";
      let args = chunk.input ? JSON.stringify(chunk.input) : "";
      if (!args && state.commandcodeToolArgBuffer?.has(toolCallId)) {
        args = state.commandcodeToolArgBuffer.get(toolCallId) || "";
      }
      results.push({
        id: state.messageId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: getToolCallIndex(state, { id: toolCallId }),
              id: toolCallId,
              type: "function",
              function: {
                name,
                arguments: args,
              },
            }],
          },
        }],
      });
      break;
    }
    case "finish-step": {
      state.finishReason = chunk.rawFinishReason === "tool_calls" || chunk.finishReason === "tool-calls"
        ? "tool_calls"
        : chunk.rawFinishReason || chunk.finishReason || state.finishReason || "stop";
      state.usage = chunk.usage?.raw
        ? {
            prompt_tokens: chunk.usage.raw.prompt_tokens || 0,
            completion_tokens: chunk.usage.raw.completion_tokens || 0,
            total_tokens: chunk.usage.raw.total_tokens || ((chunk.usage.raw.prompt_tokens || 0) + (chunk.usage.raw.completion_tokens || 0)),
          }
        : state.usage;
      results.push(...buildChunksFromResponseBlocks(chunk, state));
      break;
    }
    case "finish": {
      state.commandcodeStarted = false;
      state.commandcodeToolIndexes = new Map();
      const rawFinish = chunk.rawFinishReason || chunk.stop_reason || chunk.finishReason;
      state.finishReason = state.commandcodePseudoToolCalls?.length > 0
        ? "tool_calls"
        : rawFinish === "tool_calls" || rawFinish === "tool-calls" ? "tool_calls" : (rawFinish || state.finishReason || "stop");
      if (!state.usage && chunk.totalUsage) {
        state.usage = {
          prompt_tokens: chunk.totalUsage.inputTokens || 0,
          completion_tokens: chunk.totalUsage.outputTokens || 0,
          total_tokens: chunk.totalUsage.totalTokens || ((chunk.totalUsage.inputTokens || 0) + (chunk.totalUsage.outputTokens || 0)),
        };
      }
      results.push(...buildChunksFromResponseBlocks(chunk, state));
      const finishChunk = {
        id: state.messageId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{
          index: 0,
          delta: state.commandcodePseudoToolCalls?.length > 0
            ? { tool_calls: state.commandcodePseudoToolCalls.map((toolCall, index) => ({ ...toolCall, index })) }
            : {},
          finish_reason: state.finishReason,
        }],
      };
      if (state.usage) finishChunk.usage = state.usage;
      results.push(finishChunk);
      state.commandcodePseudoToolCalls = [];
      state.commandcodePseudoTextBuffer = "";
      state.commandcodeResponseBlockCache = new Set();
      state.commandcodeToolArgBuffer = new Map();
      break;
    }
    case "error":
      console.error(`[CommandCode] API error: ${JSON.stringify(chunk)}`);
      state.commandcodeError = chunk.error || chunk.message || "Unknown API error";
      break;
    case "ping":
      break;
    default:
      break;
  }

  return results;
}

register(FORMATS.COMMANDCODE, FORMATS.OPENAI, null, commandcodeToOpenAI);
