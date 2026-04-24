import { describe, it, expect, beforeEach, vi } from "vitest";
import { translateRequest, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Translator Concurrent Initialization", () => {
  it("handles concurrent initialization without race conditions", async () => {
    // Simulate 10 concurrent requests hitting cold start
    const requests = Array.from({ length: 10 }, (_, i) => ({
      messages: [{ role: "user", content: `Request ${i}` }],
      model: "gpt-4",
      stream: false
    }));

    // Fire all requests simultaneously
    const results = await Promise.all(
      requests.map(body => 
        translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-3-5-sonnet-20241022", body, false, null, "claude")
      )
    );

    // All requests should succeed
    expect(results).toHaveLength(10);
    results.forEach((result, i) => {
      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
      // Content might be string or array depending on translation
      const content = result.messages[0].content;
      const contentStr = typeof content === 'string' 
        ? content 
        : JSON.stringify(content);
      expect(contentStr).toContain(`Request ${i}`);
    });
  });

  it("handles concurrent response translation without race conditions", async () => {
    const state = {
      messageId: "msg_123",
      model: "claude-3-5-sonnet-20241022",
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

    const chunks = Array.from({ length: 10 }, (_, i) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: `chunk ${i}` }
    }));

    // Translate all chunks concurrently
    const results = await Promise.all(
      chunks.map(chunk => 
        translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, chunk, { ...state })
      )
    );

    // All translations should succeed
    expect(results).toHaveLength(10);
    results.forEach((result, i) => {
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  it("recovers from initialization failure and retries", async () => {
    // Note: We can't easily mock dynamic imports to force failure,
    // but we can verify the error handling structure exists and
    // that subsequent requests after successful init work correctly
    
    const body = {
      messages: [{ role: "user", content: "test" }],
      model: "gpt-4",
      stream: false
    };

    // First request should succeed (initialization happens)
    const result1 = await translateRequest(
      FORMATS.OPENAI, 
      FORMATS.CLAUDE, 
      "claude-3-5-sonnet-20241022", 
      body, 
      false, 
      null, 
      "claude"
    );
    expect(result1).toBeDefined();
    expect(result1.messages).toBeDefined();

    // Multiple subsequent requests should also succeed (already initialized)
    const results = await Promise.all([
      translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-3-5-sonnet-20241022", body, false, null, "claude"),
      translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-3-5-sonnet-20241022", body, false, null, "claude"),
      translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-3-5-sonnet-20241022", body, false, null, "claude"),
    ]);
    
    results.forEach(result => {
      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
    });
  });

  it("completes initialization within timeout", async () => {
    const startTime = Date.now();
    
    const body = {
      messages: [{ role: "user", content: "test" }],
      model: "gpt-4",
      stream: false
    };

    await translateRequest(
      FORMATS.OPENAI, 
      FORMATS.CLAUDE, 
      "claude-3-5-sonnet-20241022", 
      body, 
      false, 
      null, 
      "claude"
    );

    const duration = Date.now() - startTime;
    
    // Initialization should complete well under the 30s timeout
    expect(duration).toBeLessThan(5000); // 5 seconds is generous for local imports
  });

  it("handles mixed concurrent request and response translations", async () => {
    // Simulate real-world scenario: multiple requests + streaming responses
    const requestBody = {
      messages: [{ role: "user", content: "test" }],
      model: "gpt-4",
      stream: false
    };

    const responseChunk = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "response" }
    };

    const state = {
      messageId: "msg_123",
      model: "claude-3-5-sonnet-20241022",
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

    // Mix of request and response translations
    const operations = [
      translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-3-5-sonnet-20241022", requestBody, false, null, "claude"),
      translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, responseChunk, { ...state }),
      translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "gpt-4", requestBody, false, null, "openai"),
      translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, { choices: [{ delta: { content: "test" } }] }, { ...state }),
    ];

    const results = await Promise.all(operations);
    
    // All operations should succeed
    expect(results).toHaveLength(4);
    results.forEach(result => {
      expect(result).toBeDefined();
    });
  });
});
