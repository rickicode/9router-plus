/**
 * Kimi MITM - PATCH Google Vertex format directly
 * 1. Find request.contents (Google format)
 * 2. For each model message with functionCall but NO thought → add thought part with cached reasoning
 * 3. Keep thinking: enabled so Kimi works with reasoning
 */
const fs = require('fs');
const path = require('path');
const LOG_FILE = path.join(require('os').homedir(), '.9router', 'kimi_debug.log');
const LOG_DIR = path.dirname(LOG_FILE);

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function fileLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch(e) {}
}

const SESSION_TTL_MS = 120 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MAX_CONTENTS = 1000;
const sessionStore = new Map();
const crypto = require('crypto');

function isKimiModel(model) {
  if (!model || typeof model !== "string") return false;
  const m = model.toLowerCase();
  return m.startsWith("kimi-") || m === "kimi" || m.startsWith("if/kimi");
}

function getSessionKey(req, parsedBody) {
  const convId = parsedBody?.conversationId || 
                 req.headers?.['x-request-id'] || 
                 crypto.randomUUID();
  return `kimi:${convId}`;
}

function getSession(key) {
  const s = sessionStore.get(key);
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    sessionStore.delete(key);
    return null;
  }
  return s;
}

function upsertSession(key, patch) {
  // Evict oldest session if at capacity
  if (!sessionStore.has(key) && sessionStore.size >= MAX_SESSIONS) {
    const firstKey = sessionStore.keys().next().value;
    sessionStore.delete(firstKey);
    fileLog(`[SESSION] evicted oldest session: ${firstKey}`);
  }
  
  const existing = sessionStore.get(key) || { lastAssistantReasoning: null, createdAt: Date.now() };
  const updated = { ...existing, ...patch, updatedAt: Date.now() };
  sessionStore.set(key, updated);
  fileLog(`[SESSION] saved reasoning len=${(updated.lastAssistantReasoning||"").length}`);
  return updated;
}

async function buildKimiBody(parsedBody, req, logFn) {
  const sk = getSessionKey(req, parsedBody);
  const session = getSession(sk);
  const lastReasoning = session?.lastAssistantReasoning;
  
  // Find request.contents (Google Vertex format)
  let contents = null;
  if (parsedBody.request?.contents && Array.isArray(parsedBody.request.contents)) {
    contents = parsedBody.request.contents;
  } else if (parsedBody.contents && Array.isArray(parsedBody.contents)) {
    contents = parsedBody.contents;
  }
  
  if (!contents) {
    fileLog(`[BUILD] no request.contents found`);
    const body = { ...parsedBody, thinking: { type: "enabled", keep: "all" } };
    return { body, sessionKey: sk };
  }
  
  // Validate array size to prevent DoS
  if (contents.length > MAX_CONTENTS) {
    throw new Error(`Contents array too large: ${contents.length} (max: ${MAX_CONTENTS})`);
  }
  
  fileLog(`[BUILD] google contents=${contents.length} hasCachedReasoning=${!!lastReasoning}`);
  
  // Patch model messages: add thought part if functionCall exists but no thought
  let patchedCount = 0;
  if (lastReasoning) {
    for (let i = 0; i < contents.length; i++) {
      const item = contents[i];
      if (item.role === "model") {
        let parts = null;
        if (item.parts) parts = item.parts;
        else if (item.content?.parts) parts = item.content.parts;
        else if (Array.isArray(item.content)) parts = item.content;
        
        if (parts && Array.isArray(parts)) {
          const hasFC = parts.some(p => p.functionCall);
          const hasThought = parts.some(p => p.thought === true);
          if (hasFC && !hasThought) {
            // Insert thought part BEFORE functionCall
            const fcIndex = parts.findIndex(p => p.functionCall);
            parts.splice(fcIndex, 0, { thought: true, text: lastReasoning || "thinking..." });
            patchedCount++;
            fileLog(`[BUILD] patched msg[${i}] - added thought before functionCall`);
          }
        }
      }
    }
  }
  
  fileLog(`[BUILD] patched ${patchedCount} model messages`);
  
  const body = {
    ...parsedBody,
    thinking: { type: "enabled", keep: "all" }
  };
  
  return { body, sessionKey: sk };
}

async function handleKimiSSE(resp, res, sk, model, logFn) {
  const ctType = resp.headers.get("content-type") || "application/json";
  res.writeHead(200, { "Content-Type": ctType, "Cache-Control": "no-cache", Connection: "keep-alive" });

  if (!resp.body) {
    const txt = await resp.text().catch(() => "");
    res.end(txt);
    return;
  }

  const rdr = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let rcAcc = "";
  let hasToolCalls = false;

  try {
    for (;;) {
      const { done, value } = await rdr.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();

      for (const ln of lines) {
        if (ln.startsWith("data: ")) {
          const dd = ln.slice(6).trim();
          if (dd && dd !== "[DONE]") {
            try {
              const pj = JSON.parse(dd);
              // Try Google format first
              const candidates = pj?.response?.candidates || pj?.candidates || [];
              for (const cand of candidates) {
                const parts = cand?.content?.parts || [];
                for (const part of parts) {
                  if (part.thought === true && typeof part.text === "string") {
                    rcAcc += part.text;
                  } else if (part.functionCall) {
                    hasToolCalls = true;
                  }
                }
              }
              // Also check OpenAI format
              const choices = pj?.choices || [];
              for (const choice of choices) {
                const delta = choice.delta || {};
                if (delta.reasoning_content || delta.reasoning) {
                  rcAcc += delta.reasoning_content || delta.reasoning;
                }
                if (delta.tool_calls) {
                  hasToolCalls = true;
                }
              }
            } catch (e) {}
          }
        }
        res.write(ln + "\n");
      }
    }
    res.end();

    fileLog(`[SSE_EXIT] rcLen=${rcAcc.length} hasTC=${hasToolCalls}`);
    if (sk && rcAcc) {
      upsertSession(sk, { lastAssistantReasoning: rcAcc });
    }
  } catch (err) {
    fileLog(`[SSE] error: ${err.message}`);
    if (!res.writableEnded) res.end();
  }
}

module.exports = {
  isKimiModel,
  buildKimiBody,
  handleKimiSSE,
  getSessionKey,
  pruneExpiredSessions: () => {
    const now = Date.now();
    for (const [key, s] of sessionStore) {
      if (now - s.updatedAt > SESSION_TTL_MS) sessionStore.delete(key);
    }
  },
  PRUNE_INTERVAL_MS: 600000
};
