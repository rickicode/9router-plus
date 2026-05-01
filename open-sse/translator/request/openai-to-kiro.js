/**
 * OpenAI to Kiro Request Translator
 * Converts OpenAI Chat Completions format to Kiro/AWS CodeWhisperer format
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { v4 as uuidv4 } from "uuid";

const DEFAULT_KIRO_PAYLOAD_MAX_BYTES = 580000;
const KIRO_HISTORY_MESSAGE_MAX_CHARS = 12000;
const KIRO_TOOL_RESULT_MAX_CHARS = 4000;
const KIRO_TOOL_DESCRIPTION_MAX_CHARS = 1000;
const KIRO_TOOL_SCHEMA_MAX_BYTES = 8000;

function getKiroPayloadMaxBytes() {
  const configuredBytes = Number(globalThis.process?.env?.KIRO_MAX_PAYLOAD_BYTES);
  if (Number.isFinite(configuredBytes) && configuredBytes > 10000) {
    return configuredBytes;
  }

  // Backward-compatible fallback: legacy env name is in chars, but the value is
  // now interpreted as a serialized payload byte budget.
  const configuredChars = Number(globalThis.process?.env?.KIRO_MAX_PAYLOAD_CHARS);
  return Number.isFinite(configuredChars) && configuredChars > 10000
    ? configuredChars
    : DEFAULT_KIRO_PAYLOAD_MAX_BYTES;
}

function getJsonLength(value) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof Buffer !== "undefined") {
      return Buffer.byteLength(serialized, "utf8");
    }
    return new TextEncoder().encode(serialized).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateMiddle(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  const marker = `\n\n[... truncated ${value.length - maxChars} characters to fit Kiro input limit ...]\n\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(remaining * 0.6);
  const tailLength = Math.max(0, remaining - headLength);
  return `${value.slice(0, headLength)}${marker}${tailLength > 0 ? value.slice(-tailLength) : ""}`;
}

function trimMessageText(message, maxChars) {
  if (message?.userInputMessage?.content) {
    message.userInputMessage.content = truncateMiddle(message.userInputMessage.content, maxChars);
  }
  if (message?.assistantResponseMessage?.content) {
    message.assistantResponseMessage.content = truncateMiddle(message.assistantResponseMessage.content, maxChars);
  }
}

function trimToolResults(context) {
  const toolResults = context?.toolResults;
  if (!Array.isArray(toolResults)) return;

  for (const result of toolResults) {
    if (!Array.isArray(result?.content)) continue;
    for (const item of result.content) {
      if (typeof item?.text === "string") {
        item.text = truncateMiddle(item.text, KIRO_TOOL_RESULT_MAX_CHARS);
      }
    }
  }
}

function trimTools(context) {
  const tools = context?.tools;
  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    const spec = tool?.toolSpecification;
    if (!spec) continue;
    if (typeof spec.description === "string") {
      spec.description = truncateMiddle(spec.description, KIRO_TOOL_DESCRIPTION_MAX_CHARS);
    }
    if (getJsonLength(spec.inputSchema) > KIRO_TOOL_SCHEMA_MAX_BYTES) {
      spec.inputSchema = { json: { type: "object", properties: {}, required: [] } };
    }
  }
}

function getCurrentMessageContentOverhead(payload, state, currentMessage) {
  return getJsonLength({
    ...payload,
    conversationState: {
      ...state,
      currentMessage: {
        userInputMessage: {
          ...currentMessage.userInputMessage,
          content: "",
        },
      },
    },
  });
}

function trimCurrentMessageToBudget(payload, state, currentMessage, maxBytes, reserveBytes) {
  if (!currentMessage?.userInputMessage?.content) return;

  const overhead = getCurrentMessageContentOverhead(payload, state, currentMessage);
  const available = maxBytes - overhead - reserveBytes;
  if (available <= 0) {
    currentMessage.userInputMessage.content = "";
    return;
  }

  currentMessage.userInputMessage.content = truncateMiddle(currentMessage.userInputMessage.content, available);
}

function dropImages(message) {
  if (message?.userInputMessage?.images) {
    delete message.userInputMessage.images;
  }
}

function cleanupEmptyContext(message) {
  const context = message?.userInputMessage?.userInputMessageContext;
  if (context && Object.keys(context).length === 0) {
    delete message.userInputMessage.userInputMessageContext;
  }
}

function enforceKiroPayloadLimit(payload) {
  const maxBytes = getKiroPayloadMaxBytes();
  if (getJsonLength(payload) <= maxBytes) return payload;

  const state = payload?.conversationState;
  const history = Array.isArray(state?.history) ? state.history : [];
  const currentMessage = state?.currentMessage;

  for (const item of history) {
    trimMessageText(item, KIRO_HISTORY_MESSAGE_MAX_CHARS);
    trimToolResults(item.userInputMessage?.userInputMessageContext);
  }
  trimToolResults(currentMessage?.userInputMessage?.userInputMessageContext);
  trimTools(currentMessage?.userInputMessage?.userInputMessageContext);

  while (getJsonLength(payload) > maxBytes && history.length > 0) {
    history.shift();
  }

  if (getJsonLength(payload) > maxBytes) {
    dropImages(currentMessage);
    for (const item of history) dropImages(item);
  }

  if (getJsonLength(payload) > maxBytes && currentMessage?.userInputMessage?.content) {
    trimCurrentMessageToBudget(payload, state, currentMessage, maxBytes, 2000);
  }

  if (getJsonLength(payload) > maxBytes && currentMessage?.userInputMessage?.userInputMessageContext?.tools) {
    delete currentMessage.userInputMessage.userInputMessageContext.tools;
    cleanupEmptyContext(currentMessage);
  }

  if (getJsonLength(payload) > maxBytes && currentMessage?.userInputMessage?.userInputMessageContext?.toolResults) {
    delete currentMessage.userInputMessage.userInputMessageContext.toolResults;
    cleanupEmptyContext(currentMessage);
  }

  if (getJsonLength(payload) > maxBytes && currentMessage?.userInputMessage?.content) {
    trimCurrentMessageToBudget(payload, state, currentMessage, maxBytes, 0);
  }

  return payload;
}

/**
 * Convert OpenAI messages to Kiro format
 * Rules: system/tool/user -> user role, merge consecutive same roles
 */
function convertMessages(messages, tools, model) {
  let history = [];
  let currentMessage = null;
  
  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let pendingImages = [];
  let currentRole = null;

  // Image support is pre-filtered by caps in translateRequest before reaching here
  const supportsImages = true;

  const flushPending = () => {
    if (currentRole === "user") {
      const content = pendingUserContent.join("\n\n").trim() || "continue";
      const userMsg = {
        userInputMessage: {
          content: content,
          modelId: ""
        }
      };

      // Attach images if present (Kiro API supports images field)
      if (pendingImages.length > 0) {
        userMsg.userInputMessage.images = pendingImages;
      }

      if (pendingToolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = {
          toolResults: pendingToolResults
        };
      }
      
      // Add tools to first user message
      if (tools && tools.length > 0 && history.length === 0) {
        if (!userMsg.userInputMessage.userInputMessageContext) {
          userMsg.userInputMessage.userInputMessageContext = {};
        }
        userMsg.userInputMessage.userInputMessageContext.tools = tools.map(t => {
          const name = t.function?.name || t.name;
          let description = t.function?.description || t.description || "";
          
          if (!description.trim()) {
            description = `Tool: ${name}`;
          }
          
          const schema = t.function?.parameters || t.parameters || t.input_schema || {};
          // Normalize schema: Kiro requires required[] and proper type/properties
          const normalizedSchema = Object.keys(schema).length === 0
            ? { type: "object", properties: {}, required: [] }
            : { ...schema, required: schema.required ?? [] };

          return {
            toolSpecification: {
              name,
              description,
              inputSchema: { json: normalizedSchema }
            }
          };
        });
      }
      
      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
      pendingImages = [];
    } else if (currentRole === "assistant") {
      const content = pendingAssistantContent.join("\n\n").trim() || "...";
      const assistantMsg = {
        assistantResponseMessage: {
          content: content
        }
      };
      history.push(assistantMsg);
      pendingAssistantContent = [];
    }
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let role = msg.role;
    
    // Normalize: system/tool -> user
    if (role === "system" || role === "tool") {
      role = "user";
    }
    
    // If role changes, flush pending
    if (role !== currentRole && currentRole !== null) {
      flushPending();
    }
    currentRole = role;
    
    if (role === "user") {
      // Extract content
      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        for (const c of msg.content) {
          if (c.type === "text" || c.text) {
            textParts.push(c.text || "");
          } else if (supportsImages && c.type === "image_url") {
            // OpenAI format: image_url.url with data URI
            const url = c.image_url?.url || "";
            const base64Match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
              const mediaType = base64Match[1];
              const format = mediaType.split("/")[1] || mediaType;
              pendingImages.push({ format, source: { bytes: base64Match[2] } });
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
              // Kiro only supports base64 — fallback to URL text
              textParts.push(`[Image: ${url}]`);
            }
          } else if (supportsImages && c.type === "image") {
            // Claude format: source.type = "base64", source.media_type, source.data
            if (c.source?.type === "base64" && c.source?.data) {
              const mediaType = c.source.media_type || "image/png";
              const format = mediaType.split("/")[1] || mediaType;
              pendingImages.push({ format, source: { bytes: c.source.data } });
            }
          }
        }
        content = textParts.join("\n");
        
        // Check for tool_result blocks
        const toolResultBlocks = msg.content.filter(c => c.type === "tool_result");
        if (toolResultBlocks.length > 0) {
          toolResultBlocks.forEach(block => {
            const text = Array.isArray(block.content) 
              ? block.content.map(c => c.text || "").join("\n")
              : (typeof block.content === "string" ? block.content : "");
            
            pendingToolResults.push({
              toolUseId: block.tool_use_id,
              status: "success",
              content: [{ text: text }]
            });
          });
        }
      }
      
      // Handle tool role (from normalized)
      if (msg.role === "tool") {
        const toolContent = typeof msg.content === "string" ? msg.content : "";
        pendingToolResults.push({
          toolUseId: msg.tool_call_id,
          status: "success",
          content: [{ text: toolContent }]
        });
      } else if (content) {
        pendingUserContent.push(content);
      }
    } else if (role === "assistant") {
      // Extract text content and tool uses
      let textContent = "";
      let toolUses = [];
      
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(c => c.type === "text");
        textContent = textBlocks.map(b => b.text).join("\n").trim();
        
        const toolUseBlocks = msg.content.filter(c => c.type === "tool_use");
        toolUses = toolUseBlocks;
      } else if (typeof msg.content === "string") {
        textContent = msg.content.trim();
      }
      
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        toolUses = msg.tool_calls;
      }
      
      if (textContent) {
        pendingAssistantContent.push(textContent);
      }
      
      // Store tool uses in last assistant message
      if (toolUses.length > 0) {
        if (pendingAssistantContent.length === 0) {
          // pendingAssistantContent.push("Call tools");
        }
        
        // Flush to create assistant message with toolUses
        flushPending();
        
        const lastMsg = history[history.length - 1];
        if (lastMsg?.assistantResponseMessage) {
          lastMsg.assistantResponseMessage.toolUses = toolUses.map(tc => {
            if (tc.function) {
              return {
                toolUseId: tc.id || uuidv4(),
                name: tc.function.name,
                input: typeof tc.function.arguments === "string" 
                  ? JSON.parse(tc.function.arguments) 
                  : (tc.function.arguments || {})
              };
            } else {
              return {
                toolUseId: tc.id || uuidv4(),
                name: tc.name,
                input: tc.input || {}
              };
            }
          });
        }
        
        currentRole = null;
      }
    }
  }
  
  // Flush remaining
  if (currentRole !== null) {
    flushPending();
  }
  
  // Pop last userInputMessage as currentMessage (search from end, skip trailing assistant messages)
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].userInputMessage) {
      currentMessage = history.splice(i, 1)[0];
      break;
    }
  }

  // Grab tools from first history item BEFORE cleanup removes them
  const firstHistoryTools = history[0]?.userInputMessage?.userInputMessageContext?.tools;

  // Clean up history for Kiro API compatibility
  history.forEach(item => {
    if (item.userInputMessage?.userInputMessageContext?.tools) {
      delete item.userInputMessage.userInputMessageContext.tools;
    }
    if (item.userInputMessage?.userInputMessageContext &&
        Object.keys(item.userInputMessage.userInputMessageContext).length === 0) {
      delete item.userInputMessage.userInputMessageContext;
    }
    if (item.userInputMessage && !item.userInputMessage.modelId) {
      item.userInputMessage.modelId = model;
    }
  });

  // Merge consecutive user messages (Kiro requires alternating user/assistant)
  const mergedHistory = [];
  for (let i = 0; i < history.length; i++) {
    const current = history[i];
    if (current.userInputMessage &&
        mergedHistory.length > 0 &&
        mergedHistory[mergedHistory.length - 1].userInputMessage) {
      const prev = mergedHistory[mergedHistory.length - 1];
      prev.userInputMessage.content += "\n\n" + current.userInputMessage.content;
    } else {
      mergedHistory.push(current);
    }
  }

  // Inject tools into currentMessage AFTER cleanup
  if (firstHistoryTools && currentMessage?.userInputMessage &&
      !currentMessage.userInputMessage.userInputMessageContext?.tools) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {};
    }
    currentMessage.userInputMessage.userInputMessageContext.tools = firstHistoryTools;
  }

  return { history: mergedHistory, currentMessage };
}

/**
 * Build Kiro payload from OpenAI format
 */
export function buildKiroPayload(model, body, stream, credentials) {
  const messages = body.messages || [];
  const tools = body.tools || [];
  const maxTokens = 32000;
  const temperature = body.temperature;
  const topP = body.top_p;

  const { history, currentMessage } = convertMessages(messages, tools, model);

  const profileArn = credentials?.providerSpecificData?.profileArn || "";

  let finalContent = currentMessage?.userInputMessage?.content || "";
  const timestamp = new Date().toISOString();
  finalContent = `[Context: Current time is ${timestamp}]\n\n${finalContent}`;
  
  const payload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: uuidv4(),
      currentMessage: {
        userInputMessage: {
          content: finalContent,
          modelId: model,
          origin: "AI_EDITOR",
          ...(currentMessage?.userInputMessage?.userInputMessageContext && {
            userInputMessageContext: currentMessage.userInputMessage.userInputMessageContext
          })
        }
      },
      history: history
    }
  };

  if (profileArn) {
    payload.profileArn = profileArn;
  }

  if (maxTokens || temperature !== undefined || topP !== undefined) {
    payload.inferenceConfig = {};
    if (maxTokens) payload.inferenceConfig.maxTokens = maxTokens;
    if (temperature !== undefined) payload.inferenceConfig.temperature = temperature;
    if (topP !== undefined) payload.inferenceConfig.topP = topP;
  }

  return enforceKiroPayloadLimit(payload);
}

register(FORMATS.OPENAI, FORMATS.KIRO, buildKiroPayload, null);
