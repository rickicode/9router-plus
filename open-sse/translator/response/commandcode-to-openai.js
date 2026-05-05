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
    case "text-end":
      state.inTextBlock = false;
      break;
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
      break;
    }
    case "finish": {
      state.commandcodeStarted = false;
      state.commandcodeToolIndexes = new Map();
      const rawFinish = chunk.rawFinishReason || chunk.stop_reason || chunk.finishReason;
      state.finishReason = rawFinish === "tool_calls" || rawFinish === "tool-calls" ? "tool_calls" : (rawFinish || state.finishReason || "stop");
      if (!state.usage && chunk.totalUsage) {
        state.usage = {
          prompt_tokens: chunk.totalUsage.inputTokens || 0,
          completion_tokens: chunk.totalUsage.outputTokens || 0,
          total_tokens: chunk.totalUsage.totalTokens || ((chunk.totalUsage.inputTokens || 0) + (chunk.totalUsage.outputTokens || 0)),
        };
      }
      const finishChunk = {
        id: state.messageId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: state.finishReason,
        }],
      };
      if (state.usage) finishChunk.usage = state.usage;
      results.push(finishChunk);
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
