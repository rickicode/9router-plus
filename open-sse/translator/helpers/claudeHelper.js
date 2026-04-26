// Claude helper functions for translator
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../config/defaultThinkingSignature.js";
import { adjustMaxTokens } from "./maxTokensHelper.js";
import { applyCloaking } from "../../utils/claudeCloaking.js";
import { deriveSessionId } from "../../utils/sessionManager.js";

// Check if message has valid non-empty content
export function hasValidContent(msg) {
  if (typeof msg.content === "string" && msg.content.trim()) return true;
  if (Array.isArray(msg.content)) {
    return msg.content.some(block =>
      (block.type === "text" && block.text?.trim()) ||
      block.type === "tool_use" ||
      block.type === "tool_result"
    );
  }
  return false;
}

// Fix tool_use/tool_result ordering for Claude API
// 1. Assistant message with tool_use: remove text AFTER tool_use (Claude doesn't allow)
// 2. Merge consecutive same-role messages (tool_result blocks first, others after)
export function fixToolUseOrdering(messages) {
  if (messages.length <= 1) return messages;

  // Pass 1: Fix assistant messages with tool_use — drop text-like blocks after the
  // first tool_use. Single-pass with early-exits when no tool_use is present
  // and when no block actually needs dropping (keep the original array to
  // avoid an allocation).
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const content = msg.content;
    let firstToolUseAt = -1;
    for (let i = 0; i < content.length; i++) {
      if (content[i].type === "tool_use") {
        firstToolUseAt = i;
        break;
      }
    }
    if (firstToolUseAt === -1) continue;

    // Detect whether anything actually needs dropping. If every block past the
    // first tool_use is itself tool_use/thinking/redacted_thinking, the
    // existing array is already valid — skip the rebuild.
    let needsRebuild = false;
    for (let i = firstToolUseAt + 1; i < content.length; i++) {
      const t = content[i].type;
      if (t !== "tool_use" && t !== "thinking" && t !== "redacted_thinking") {
        needsRebuild = true;
        break;
      }
    }
    if (!needsRebuild) continue;

    const newContent = [];
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      const t = block.type;
      // Always keep thinking + tool_use blocks (Claude requires them); drop other
      // block types positioned AFTER the first tool_use.
      if (t === "tool_use" || t === "thinking" || t === "redacted_thinking") {
        newContent.push(block);
      } else if (i < firstToolUseAt) {
        newContent.push(block);
      }
    }
    msg.content = newContent;
  }

  // Pass 2: Merge consecutive same-role messages with single-pass partition.
  // tool_result blocks must come before other blocks per Claude API ordering.
  const merged = [];

  for (const msg of messages) {
    const last = merged[merged.length - 1];

    if (last && last.role === msg.role) {
      const lastContent = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
      const msgContent = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];

      // Single pass over both source arrays, partitioning into two buckets.
      const toolResults = [];
      const otherContent = [];
      for (const b of lastContent) {
        (b.type === "tool_result" ? toolResults : otherContent).push(b);
      }
      for (const b of msgContent) {
        (b.type === "tool_result" ? toolResults : otherContent).push(b);
      }
      last.content = toolResults.length > 0 ? toolResults.concat(otherContent) : otherContent;
    } else {
      // Avoid the `[...content]` clone — Pass 1 already mutated assistant
      // content arrays in place, and downstream passes only mutate block-level
      // fields (e.g. `block.cache_control`) which are shared by reference
      // regardless of array clone status.
      const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
      merged.push({ role: msg.role, content });
    }
  }

  return merged;
}

// Prepare request for Claude format endpoints
// - Cleanup cache_control
// - Filter empty messages
// - Add thinking block for Anthropic endpoint (provider === "claude")
// - Fix tool_use/tool_result ordering
// - Apply cloaking (billing header + fake user ID) for OAuth tokens
export function prepareClaudeRequest(body, provider = null, apiKey = null, connectionId = null) {
  // 1. System: remove all cache_control, add only to last block with ttl 1h.
  // Fast path: if no non-last block has cache_control AND last block already
  // has the canonical {type:"ephemeral", ttl:"1h"} mark, skip the rebuild.
  if (body.system && Array.isArray(body.system) && body.system.length > 0) {
    const lastIdx = body.system.length - 1;
    const targetCacheControl = { type: "ephemeral", ttl: "1h" };

    let needsRebuild = false;
    for (let i = 0; i < lastIdx; i++) {
      if (body.system[i] && body.system[i].cache_control !== undefined) {
        needsRebuild = true;
        break;
      }
    }
    if (!needsRebuild) {
      const lastBlock = body.system[lastIdx];
      const cc = lastBlock?.cache_control;
      if (!cc || cc.type !== "ephemeral" || cc.ttl !== "1h") {
        // Mutate in place — last block needs the canonical cache_control mark.
        if (lastBlock) lastBlock.cache_control = targetCacheControl;
      }
    } else {
      body.system = body.system.map((block, i) => {
        const { cache_control, ...rest } = block;
        if (i === lastIdx) {
          return { ...rest, cache_control: targetCacheControl };
        }
        return rest;
      });
    }
  }

  // 2. Messages: process in optimized passes
  if (body.messages && Array.isArray(body.messages)) {
    const len = body.messages.length;
    let filtered = [];

    // Pass 1: remove cache_control + filter empty messages.
    // `delete` on a missing key still mutates the object's hidden class in
    // V8 — guard with an `in`-check so messages without cache_control (the
    // overwhelming majority) keep their shape stable.
    for (let i = 0; i < len; i++) {
      const msg = body.messages[i];

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && "cache_control" in block) {
            delete block.cache_control;
          }
        }
      }

      // Keep final assistant even if empty, otherwise check valid content
      const isFinalAssistant = i === len - 1 && msg.role === "assistant";
      if (isFinalAssistant || hasValidContent(msg)) {
        filtered.push(msg);
      }
    }

    // Pass 1.5: Fix tool_use/tool_result ordering
    // Each tool_use must have tool_result in the NEXT message (not same message with other content)
    filtered = fixToolUseOrdering(filtered);

    body.messages = filtered;

    // Check if thinking is enabled AND last message is from user
    const lastMessage = filtered[filtered.length - 1];
    const lastMessageIsUser = lastMessage?.role === "user";
    const thinkingEnabled = body.thinking?.type === "enabled" && lastMessageIsUser;

    // Pass 2 (reverse): add cache_control to last assistant + handle thinking for Anthropic
    let lastAssistantProcessed = false;
    for (let i = filtered.length - 1; i >= 0; i--) {
      const msg = filtered[i];

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        // Add cache_control to last non-thinking block of first (from end) assistant with content
        // thinking/redacted_thinking blocks do not support cache_control
        if (!lastAssistantProcessed && msg.content.length > 0) {
          for (let j = msg.content.length - 1; j >= 0; j--) {
            const block = msg.content[j];
            if (block.type !== "thinking" && block.type !== "redacted_thinking") {
              block.cache_control = { type: "ephemeral" };
              break;
            }
          }
          lastAssistantProcessed = true;
        }

        // Handle thinking blocks for Anthropic endpoint only
        if (provider === "claude" || provider?.startsWith("anthropic-compatible")) {
          let hasToolUse = false;
          let hasThinking = false;

          // Always replace signature for all thinking blocks
          for (const block of msg.content) {
            if (block.type === "thinking" || block.type === "redacted_thinking") {
              block.signature = DEFAULT_THINKING_CLAUDE_SIGNATURE;
              hasThinking = true;
            }
            if (block.type === "tool_use") hasToolUse = true;
          }

          // Add thinking block if thinking enabled + has tool_use but no thinking
          if (thinkingEnabled && !hasThinking && hasToolUse) {
            msg.content.unshift({
              type: "thinking",
              thinking: ".",
              signature: DEFAULT_THINKING_CLAUDE_SIGNATURE
            });
          }
        }
      }
    }
  }

  // 3. Tools: filter built-in tools for non-Anthropic providers, then handle cache_control
  if (body.tools && Array.isArray(body.tools)) {
    // Strip built-in tools (e.g. web_search_20250305) for providers that don't support them
    if (provider !== "claude") {
      body.tools = body.tools.filter(tool => !tool.type || tool.type === "function");
    }

    const tools = body.tools;
    const toolsLen = tools.length;

    if (toolsLen === 0) {
      delete body.tools;
      delete body.tool_choice;
    } else {
      // Fast path: rebuild only when an earlier tool carries cache_control or
      // the last tool's cache_control is not already canonical. Otherwise
      // mutate the last tool in place to set the canonical cache mark.
      const lastIdx = toolsLen - 1;
      const targetCacheControl = { type: "ephemeral", ttl: "1h" };

      let needsRebuild = false;
      for (let i = 0; i < lastIdx; i++) {
        if (tools[i] && tools[i].cache_control !== undefined) {
          needsRebuild = true;
          break;
        }
      }

      if (!needsRebuild) {
        const lastTool = tools[lastIdx];
        const cc = lastTool?.cache_control;
        if (!cc || cc.type !== "ephemeral" || cc.ttl !== "1h") {
          if (lastTool) lastTool.cache_control = targetCacheControl;
        }
      } else {
        body.tools = tools.map((tool, i) => {
          const { cache_control, ...rest } = tool;
          if (i === lastIdx) {
            return { ...rest, cache_control: targetCacheControl };
          }
          return rest;
        });
      }
    }
  }

  // Apply cloaking for OAuth tokens (billing header + fake user ID)
  // session_id in user_id must match X-Claude-Code-Session-Id for fingerprint consistency
  if ((provider === "claude" || provider?.startsWith("anthropic-compatible")) && apiKey) {
    const sessionId = connectionId ? deriveSessionId(connectionId) : null;
    body = applyCloaking(body, apiKey, sessionId);
  }

  return body;
}

