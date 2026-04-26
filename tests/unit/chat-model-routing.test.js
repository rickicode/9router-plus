import { beforeEach, describe, expect, it, vi } from "vitest";

const getProviderCredentials = vi.fn();
const markAccountUnavailable = vi.fn();
const clearAccountError = vi.fn();
const extractApiKey = vi.fn(() => null);
const isValidApiKey = vi.fn(() => true);
const getSettings = vi.fn(async () => ({
  requireApiKey: false,
  ccFilterNaming: false,
  comboStrategies: {},
  comboStrategy: "fallback",
  providerThinking: {},
}));
const getModelInfo = vi.fn();
const getComboModels = vi.fn(async () => null);
const handleChatCore = vi.fn();
const errorResponse = vi.fn((status, message) => ({ status, body: { error: { message } } }));
const unavailableResponse = vi.fn((status, message) => ({ status, body: { error: { message } } }));
const handleComboChat = vi.fn();
const handleBypassRequest = vi.fn(async () => null);
const detectFormatByEndpoint = vi.fn(() => "openai");
const updateProviderCredentials = vi.fn();
const checkAndRefreshToken = vi.fn(async (_provider, credentials) => credentials);
const getProjectIdForConnection = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getSettings,
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo,
  getComboModels,
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore,
}));

vi.mock("open-sse/utils/error.js", () => ({
  errorResponse,
  unavailableResponse,
}));

vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat,
}));

vi.mock("open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest,
}));

vi.mock("open-sse/config/runtimeConfig.js", () => ({
  HTTP_STATUS: {
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    NOT_FOUND: 404,
    SERVICE_UNAVAILABLE: 503,
  },
}));

vi.mock("open-sse/translator/formats.js", () => ({
  detectFormatByEndpoint,
}));

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials,
  checkAndRefreshToken,
}));

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection,
}));

vi.mock("open-sse/utils/claudeHeaderCache.js", () => ({
  cacheClaudeHeaders: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

describe("chat model routing", () => {
  beforeEach(() => {
    vi.resetModules();
    getProviderCredentials.mockReset();
    markAccountUnavailable.mockReset();
    clearAccountError.mockReset();
    extractApiKey.mockReset();
    isValidApiKey.mockReset();
    getSettings.mockReset();
    getModelInfo.mockReset();
    getComboModels.mockReset();
    handleChatCore.mockReset();
    errorResponse.mockClear();
    unavailableResponse.mockClear();
    handleComboChat.mockReset();
    handleBypassRequest.mockReset();
    detectFormatByEndpoint.mockReset();
    updateProviderCredentials.mockReset();
    checkAndRefreshToken.mockReset();
    getProjectIdForConnection.mockReset();

    extractApiKey.mockReturnValue(null);
    isValidApiKey.mockResolvedValue(true);
    getSettings.mockResolvedValue({
      requireApiKey: false,
      ccFilterNaming: false,
      comboStrategies: {},
      comboStrategy: "fallback",
      providerThinking: {},
    });
    getComboModels.mockResolvedValue(null);
    handleBypassRequest.mockResolvedValue(null);
    detectFormatByEndpoint.mockReturnValue("openai");
    checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
  });

  function makeRequest(model) {
    return {
      url: "http://localhost/v1/chat/completions",
      json: async () => ({ model, messages: [{ role: "user", content: "hi" }] }),
      headers: {
        get(name) {
          if (name.toLowerCase() === "user-agent") return "vitest";
          if (name.toLowerCase() === "authorization") return null;
          return null;
        },
        entries() {
          return [];
        },
      },
    };
  }

  it("prefers codex first for bare gpt model when codex has the same model", async () => {
    getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-5.4" });
    getProviderCredentials.mockResolvedValue({ connectionId: "codex-1", connectionName: "Codex", accessToken: "token" });
    handleChatCore.mockResolvedValue({ success: true, response: { status: 200, body: { ok: true } } });

    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const response = await handleChat(makeRequest("gpt-5.4"));

    expect(getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(getProviderCredentials).toHaveBeenCalledWith("codex", expect.any(Set), "gpt-5.4");
    expect(handleChatCore).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ model: "codex/gpt-5.4" }),
      modelInfo: { provider: "codex", model: "gpt-5.4" },
    }));
    expect(response).toEqual({ status: 200, body: { ok: true } });
  });

  it("falls back to openai when codex-first bare gpt model has no codex credentials", async () => {
    getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-5.4" });
    getProviderCredentials
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ connectionId: "openai-1", connectionName: "OpenAI", accessToken: "token" });
    handleChatCore.mockResolvedValue({ success: true, response: { status: 200, body: { ok: true } } });

    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    await handleChat(makeRequest("gpt-5.4"));

    expect(getProviderCredentials).toHaveBeenNthCalledWith(1, "codex", expect.any(Set), "gpt-5.4");
    expect(getProviderCredentials).toHaveBeenNthCalledWith(2, "openai", expect.any(Set), "gpt-5.4");
    expect(handleChatCore).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ model: "openai/gpt-5.4" }),
      modelInfo: { provider: "openai", model: "gpt-5.4" },
    }));
  });

  it("keeps bare openai-family models on openai when codex lacks the same model", async () => {
    getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-4o-mini" });
    getProviderCredentials.mockResolvedValue({ connectionId: "openai-1", connectionName: "OpenAI", accessToken: "token" });
    handleChatCore.mockResolvedValue({ success: true, response: { status: 200, body: { ok: true } } });

    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    await handleChat(makeRequest("gpt-4o-mini"));

    expect(getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(getProviderCredentials).toHaveBeenCalledWith("openai", expect.any(Set), "gpt-4o-mini");
    expect(handleChatCore).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ model: "openai/gpt-4o-mini" }),
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
    }));
  });

  it("does not retry codex for bare openai-family models missing from codex", async () => {
    getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-4o-mini" });
    getProviderCredentials.mockResolvedValue(null);

    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const response = await handleChat(makeRequest("gpt-4o-mini"));

    expect(getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(getProviderCredentials).toHaveBeenCalledWith("openai", expect.any(Set), "gpt-4o-mini");
    expect(errorResponse).toHaveBeenCalledWith(404, "No active credentials for provider: openai");
    expect(response).toEqual({ status: 404, body: { error: { message: "No active credentials for provider: openai" } } });
  });

  it("does not fall back explicit openai-prefixed requests to codex", async () => {
    getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-5.4" });
    getProviderCredentials.mockResolvedValue(null);

    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const response = await handleChat(makeRequest("openai/gpt-5.4"));

    expect(getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(getProviderCredentials).toHaveBeenCalledWith("openai", expect.any(Set), "gpt-5.4");
    expect(errorResponse).toHaveBeenCalledWith(404, "No active credentials for provider: openai");
    expect(response).toEqual({ status: 404, body: { error: { message: "No active credentials for provider: openai" } } });
  });
});
