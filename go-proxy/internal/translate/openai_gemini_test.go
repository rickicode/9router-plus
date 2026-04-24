package translate

import (
	"strings"
	"testing"
)

func TestOpenAIToGemini_BasicMessage(t *testing.T) {
	body := map[string]any{
		"model": "gemini-2.5-pro",
		"messages": []any{
			map[string]any{"role": "system", "content": "You are helpful"},
			map[string]any{"role": "user", "content": "Hello"},
		},
	}
	got, err := OpenAIToGeminiRequest("gemini-2.5-pro", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, ok := got["systemInstruction"]; !ok {
		t.Fatalf("expected systemInstruction field")
	}

	contents, ok := got["contents"].([]any)
	if !ok || len(contents) != 1 {
		t.Fatalf("expected 1 content, got %#v", got["contents"])
	}

	content := contents[0].(map[string]any)
	if content["role"] != "user" {
		t.Fatalf("expected user role, got %#v", content["role"])
	}
}

func TestOpenAIToGemini_GenerationConfig(t *testing.T) {
	body := map[string]any{
		"messages":    []any{map[string]any{"role": "user", "content": "Hi"}},
		"temperature": 0.7,
		"top_p":       0.9,
		"top_k":       40,
		"max_tokens":  1024,
	}
	got, err := OpenAIToGeminiRequest("gemini-2.5-pro", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	config := got["generationConfig"].(map[string]any)
	if config["temperature"] != 0.7 {
		t.Fatalf("expected temperature 0.7, got %#v", config["temperature"])
	}
	if config["topP"] != 0.9 {
		t.Fatalf("expected topP 0.9, got %#v", config["topP"])
	}
	if config["topK"] != 40 {
		t.Fatalf("expected topK 40, got %#v", config["topK"])
	}
	if config["maxOutputTokens"] != 1024 {
		t.Fatalf("expected maxOutputTokens 1024, got %#v", config["maxOutputTokens"])
	}
}

func TestOpenAIToGemini_ToolCalls(t *testing.T) {
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
				"content":      `{"temp":72}`,
			},
		},
	}
	got, err := OpenAIToGeminiRequest("gemini-2.5-pro", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	contents := got["contents"].([]any)
	if len(contents) != 2 {
		t.Fatalf("expected 2 contents (model + user), got %d", len(contents))
	}

	modelContent := contents[0].(map[string]any)
	if modelContent["role"] != "model" {
		t.Fatalf("expected model role, got %#v", modelContent["role"])
	}
	parts := modelContent["parts"].([]any)
	part := parts[0].(map[string]any)
	if _, ok := part["functionCall"]; !ok {
		t.Fatalf("expected functionCall in parts")
	}

	userContent := contents[1].(map[string]any)
	if userContent["role"] != "user" {
		t.Fatalf("expected user role, got %#v", userContent["role"])
	}
}

func TestOpenAIToGemini_ToolResponsePreservesExistingResult(t *testing.T) {
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
				"content":      `{"result":{"temp":72}}`,
			},
		},
	}
	got, err := OpenAIToGeminiRequest("gemini-2.5-pro", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	contents := got["contents"].([]any)
	userContent := contents[1].(map[string]any)
	parts := userContent["parts"].([]any)
	response := parts[0].(map[string]any)["functionResponse"].(map[string]any)["response"].(map[string]any)
	inner := response["result"].(map[string]any)
	if inner["temp"] != float64(72) {
		t.Fatalf("expected existing result map to be preserved, got %#v", response)
	}
}

func TestSanitizeGeminiFunctionName_LimitsBytes(t *testing.T) {
	name := "1" + strings.Repeat("界", 40)
	sanitized := sanitizeGeminiFunctionName(name)
	if len([]byte(sanitized)) > 64 {
		t.Fatalf("expected sanitized name to be at most 64 bytes, got %d", len([]byte(sanitized)))
	}
}

func TestOpenAIToGemini_Tools(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "Weather?"},
		},
		"tools": []any{
			map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        "get-weather",
					"description": "Get weather",
					"parameters": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"city": map[string]any{"type": "string"},
						},
					},
				},
			},
		},
	}
	got, err := OpenAIToGeminiRequest("gemini-2.5-pro", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	tools := got["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}

	tool := tools[0].(map[string]any)
	declarations := tool["functionDeclarations"].([]any)
	if len(declarations) != 1 {
		t.Fatalf("expected 1 declaration, got %d", len(declarations))
	}

	decl := declarations[0].(map[string]any)
	if decl["name"] != "get_weather" {
		t.Fatalf("expected sanitized name get_weather, got %#v", decl["name"])
	}
}

func TestOpenAIToGemini_SafetySettings(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "Hi"},
		},
	}
	got, err := OpenAIToGeminiRequest("gemini-2.5-pro", body, true, TranslateOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, ok := got["safetySettings"]; !ok {
		t.Fatalf("expected safetySettings field")
	}
}

func TestOpenAIToGemini_CustomSafetySettings(t *testing.T) {
	body := map[string]any{"messages": []any{map[string]any{"role": "user", "content": "Hi"}}}
	settings := []map[string]any{{"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_ONLY_HIGH"}}
	got, err := OpenAIToGeminiRequest("gemini-2.5-pro", body, true, TranslateOptions{SafetySettings: settings})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	actual := got["safetySettings"].([]any)
	if len(actual) != 1 || actual[0].(map[string]any)["threshold"] != "BLOCK_ONLY_HIGH" {
		t.Fatalf("expected custom safety settings, got %#v", actual)
	}
}

func TestSanitizeGeminiFunctionName_PrefixesLeadingDigits(t *testing.T) {
	if got := sanitizeGeminiFunctionName("123weather"); got != "_123weather" {
		t.Fatalf("expected leading digit name to be prefixed, got %q", got)
	}
}

func TestValidatedGeminiToolResponse_NonStringContent(t *testing.T) {
	response := validatedGeminiToolResponse(map[string]any{"ok": true}).(map[string]any)
	result := response["result"].(map[string]any)
	if result["ok"] != true {
		t.Fatalf("expected structured result to be preserved, got %#v", response)
	}
}
