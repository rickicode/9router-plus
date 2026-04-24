package translate

import (
	"strings"
	"testing"
)

func TestOpenAIToClaude_BasicMessage(t *testing.T) {
	body := map[string]any{
		"model": "claude-sonnet-4",
		"messages": []any{
			map[string]any{"role": "system", "content": "You are helpful"},
			map[string]any{"role": "user", "content": "Hello"},
		},
	}
	got, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got["model"] != "claude-sonnet-4" {
		t.Fatalf("expected model to be preserved, got %#v", got["model"])
	}
	if got["stream"] != true {
		t.Fatalf("expected stream true, got %#v", got["stream"])
	}

	// Check system field
	system, ok := got["system"].([]any)
	if !ok || len(system) == 0 {
		t.Fatalf("expected system array, got %#v", got["system"])
	}

	// Check messages
	messages, ok := got["messages"].([]any)
	if !ok || len(messages) != 1 {
		t.Fatalf("expected 1 message, got %#v", got["messages"])
	}

	msg := messages[0].(map[string]any)
	if msg["role"] != "user" {
		t.Fatalf("expected user role, got %#v", msg["role"])
	}
}

func TestOpenAIToClaude_ToolCalls(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"tool_calls": []any{
					map[string]any{
						"id":   "call_123",
						"type": "function",
						"function": map[string]any{
							"name":      "get_weather",
							"arguments": `{"city":"SF"}`,
						},
					},
				},
			},
			map[string]any{
				"role":         "tool",
				"tool_call_id": "call_123",
				"content":      "Sunny, 72F",
			},
		},
	}
	got, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	messages := got["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages (assistant + tool_result), got %d", len(messages))
	}

	assistantMsg := messages[0].(map[string]any)
	content := assistantMsg["content"].([]any)
	toolUse := content[0].(map[string]any)
	if toolUse["type"] != "tool_use" {
		t.Fatalf("expected tool_use, got %#v", toolUse)
	}

	toolMsg := messages[1].(map[string]any)
	if toolMsg["role"] != "user" {
		t.Fatalf("expected user role for tool_result, got %#v", toolMsg["role"])
	}
}

func TestOpenAIToClaude_Tools(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "What's the weather?"},
		},
		"tools": []any{
			map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        "get_weather",
					"description": "Get weather for a city",
					"parameters": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"city": map[string]any{"type": "string"},
						},
						"required": []any{"city"},
					},
				},
			},
		},
	}
	got, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	tools := got["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}

	tool := tools[0].(map[string]any)
	if tool["name"] != "get_weather" {
		t.Fatalf("expected get_weather, got %#v", tool["name"])
	}
	if _, ok := tool["input_schema"]; !ok {
		t.Fatalf("expected input_schema field")
	}
}

func TestOpenAIToClaude_ResponseFormat(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "Give me JSON"},
		},
		"response_format": map[string]any{
			"type": "json_object",
		},
	}
	got, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	system := got["system"].([]any)
	if len(system) < 1 {
		t.Fatalf("expected system prompts for JSON mode, got %d", len(system))
	}

	lastBlock := system[len(system)-1].(map[string]any)
	text := lastBlock["text"].(string)
	if !strings.Contains(text, "JSON") {
		t.Fatalf("expected JSON instruction in system, got %q", text)
	}
}

func TestOpenAIToClaude_ToolUseStaysAssistantRole(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "Call a tool"},
			map[string]any{
				"role": "assistant",
				"tool_calls": []any{
					map[string]any{
						"id":   "call_123",
						"type": "function",
						"function": map[string]any{
							"name":      "get_weather",
							"arguments": `{"city":"SF"}`,
						},
					},
				},
			},
		},
	}
	got, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	messages := got["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("expected separate user and assistant messages, got %d", len(messages))
	}
	if messages[1].(map[string]any)["role"] != "assistant" {
		t.Fatalf("expected tool_use message to remain assistant, got %#v", messages[1])
	}
}

func TestOpenAIToClaude_ClaudePromptInjectionConfigurable(t *testing.T) {
	body := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "Hello"}},
	}

	withoutPrompt, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := withoutPrompt["system"]; ok {
		t.Fatalf("expected no system prompt injection by default, got %#v", withoutPrompt["system"])
	}

	withProviderPrompt, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{Provider: "claude-cli"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	system := withProviderPrompt["system"].([]any)
	if len(system) != 1 || system[0].(map[string]any)["text"] != claudeSystemPrompt {
		t.Fatalf("expected Claude prompt for CLI provider, got %#v", system)
	}
}

func TestOpenAIToClaude_ToolChoiceNonePreserved(t *testing.T) {
	body := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "Hello"}},
		"tool_choice": "none",
	}
	got, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got["tool_choice"].(map[string]any)["type"] != "none" {
		t.Fatalf("expected tool_choice none, got %#v", got["tool_choice"])
	}
}

func TestOpenAIToClaude_ResponseFormatSchemaUsesCompactJSON(t *testing.T) {
	body := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "Give schema JSON"}},
		"response_format": map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"schema": map[string]any{
					"type": "object",
					"properties": map[string]any{"ok": map[string]any{"type": "boolean"}},
				},
			},
		},
	}
	got, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	system := got["system"].([]any)
	text := system[len(system)-1].(map[string]any)["text"].(string)
	if strings.Contains(text, "\n  \"") {
		t.Fatalf("expected compact schema JSON, got %q", text)
	}
	if !strings.Contains(text, `{"properties":{"ok":{"type":"boolean"}},"type":"object"}`) {
		t.Fatalf("expected compact schema JSON in system prompt, got %q", text)
	}
}

func TestOpenAIToClaude_InvalidImageURLDropped(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": "file:///tmp/test.png"}},
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": "/relative.png"}},
			}},
		},
	}
	got, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	messages := got["messages"].([]any)
	if len(messages) != 0 {
		t.Fatalf("expected invalid image-only message to be dropped, got %#v", messages)
	}
}

func TestOpenAIToClaude_SystemCacheControlOmitsTTL(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "rule one"},
			map[string]any{"role": "user", "content": "Hello"},
		},
	}
	got, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	system := got["system"].([]any)
	block := system[len(system)-1].(map[string]any)
	cacheControl := block["cache_control"].(map[string]any)
	if _, ok := cacheControl["ttl"]; ok {
		t.Fatalf("expected system cache_control to omit ttl, got %#v", cacheControl)
	}
}

func TestOpenAIToClaude_ToolResultSkipsInvalidIsError(t *testing.T) {
	parts := convertOpenAIContentParts([]any{map[string]any{
		"type":        "tool_result",
		"tool_use_id": "call_123",
		"content":     "ok",
		"is_error":    "true",
	}})
	block := parts[0].(map[string]any)
	if _, ok := block["is_error"]; ok {
		t.Fatalf("expected non-boolean is_error to be skipped, got %#v", block)
	}
}

func TestOpenAIToClaude_ToolsCacheControlOmitsTTL(t *testing.T) {
	body := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{"name": "tool", "parameters": map[string]any{"type": "object"}}}},
	}
	got, err := OpenAIToClaudeRequest("claude-sonnet-4", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	tool := got["tools"].([]any)[0].(map[string]any)
	cacheControl := tool["cache_control"].(map[string]any)
	if _, ok := cacheControl["ttl"]; ok {
		t.Fatalf("expected tool cache_control to omit ttl, got %#v", cacheControl)
	}
}
