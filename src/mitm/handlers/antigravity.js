const err = (msg) => console.error(`[${new Date().toLocaleTimeString("en-US", { hour12: false })}] ❌ [MITM] ${msg}`);
const log = (msg) => console.log(`[${new Date().toLocaleTimeString("en-US", { hour12: false })}] [MITM] ${msg}`);
const { fetchRouter, pipeSSE } = require("./base.js");
const { isKimiModel, buildKimiBody, handleKimiSSE, getSessionKey } = require("./kimiSession.js");

/**
 * Intercept Antigravity (Gemini) request — replace model and forward to router
 * Special handling for Kimi models: patch Google Vertex format with reasoning_content
 */
async function intercept(req, res, bodyBuffer, mappedModel) {
  try {
    const body = JSON.parse(bodyBuffer.toString());
    body.model = mappedModel;
    
    // Check if this is a Kimi model request
    if (isKimiModel(mappedModel)) {
      log(`[antigravity] Kimi model detected: ${mappedModel}`);
      
      // Build Kimi body with reasoning_content patching
      const { body: kimiBody, sessionKey } = await buildKimiBody(body, req, log);
      
      // Forward to router
      const routerRes = await fetchRouter(kimiBody, "/v1/chat/completions", req.headers);
      
      // Handle SSE response with reasoning extraction
      await handleKimiSSE(routerRes, res, sessionKey, mappedModel, log);
    } else {
      // Standard Antigravity flow
      const routerRes = await fetchRouter(body, "/v1/chat/completions", req.headers);
      await pipeSSE(routerRes, res);
    }
  } catch (error) {
    err(`[antigravity] ${error.message}`);
    
    // Sanitize error message to prevent information leakage
    let safeMessage = "Internal server error";
    if (error.message.includes("too large")) {
      safeMessage = "Request payload too large";
    } else if (error.message.includes("timeout")) {
      safeMessage = "Request timeout";
    } else if (error.message.includes("ECONNREFUSED") || error.message.includes("ENOTFOUND")) {
      safeMessage = "Service unavailable";
    }
    
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: safeMessage, type: "mitm_error" } }));
  }
}

module.exports = { intercept };
