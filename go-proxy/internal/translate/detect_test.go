package translate

import "testing"

func TestDetectFormat_OpenAIChat(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "Hello"},
		},
	}

	if got := DetectFormat(body); got != FormatOpenAI {
		t.Fatalf("expected %q, got %q", FormatOpenAI, got)
	}
}

func TestDetectFormat_OpenAIResponses(t *testing.T) {
	body := map[string]any{
		"input": []any{"Hello"},
	}

	if got := DetectFormat(body); got != FormatOpenAIResponses {
		t.Fatalf("expected %q, got %q", FormatOpenAIResponses, got)
	}
}

func TestDetectFormat_ClaudeByTypedMessageContent(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "text", "text": "Hello"},
				},
			},
		},
	}

	if got := DetectFormat(body); got != FormatClaude {
		t.Fatalf("expected %q, got %q", FormatClaude, got)
	}
}

func TestDetectFormat_ClaudeBySystemField(t *testing.T) {
	body := map[string]any{
		"system": "You are Claude",
	}

	if got := DetectFormat(body); got != FormatClaude {
		t.Fatalf("expected %q, got %q", FormatClaude, got)
	}
}

func TestDetectFormat_ClaudeByAnthropicVersion(t *testing.T) {
	body := map[string]any{
		"anthropic_version": "2023-06-01",
	}

	if got := DetectFormat(body); got != FormatClaude {
		t.Fatalf("expected %q, got %q", FormatClaude, got)
	}
}

func TestDetectFormat_Gemini(t *testing.T) {
	body := map[string]any{
		"contents": []any{
			map[string]any{"role": "user", "parts": []any{}},
		},
	}

	if got := DetectFormat(body); got != FormatGemini {
		t.Fatalf("expected %q, got %q", FormatGemini, got)
	}
}

func TestDetectFormat_Antigravity(t *testing.T) {
	body := map[string]any{
		"request": map[string]any{
			"contents": []any{},
		},
		"userAgent": "antigravity",
	}

	if got := DetectFormat(body); got != FormatAntigravity {
		t.Fatalf("expected %q, got %q", FormatAntigravity, got)
	}
}

func TestDetectFormat_OpenAISpecificFields(t *testing.T) {
	fields := []string{"stream_options", "response_format", "logprobs", "n", "presence_penalty", "frequency_penalty", "logit_bias", "user"}

	for _, field := range fields {
		t.Run(field, func(t *testing.T) {
			body := map[string]any{field: true}

			if got := DetectFormat(body); got != FormatOpenAI {
				t.Fatalf("expected %q, got %q", FormatOpenAI, got)
			}
		})
	}
}

func TestDetectFormat_DefaultsToOpenAIForAmbiguousBody(t *testing.T) {
	body := map[string]any{
		"model": "gpt-4.1",
	}

	if got := DetectFormat(body); got != FormatOpenAI {
		t.Fatalf("expected %q, got %q", FormatOpenAI, got)
	}
}
