package translate

import (
	"reflect"
	"strings"
	"testing"
)

func TestTranslateRequest_SameFormat(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "Hello"},
		},
	}
	opts := TranslateOptions{Model: "gpt-4", Stream: true}

	got, err := TranslateRequest(FormatOpenAI, FormatOpenAI, body, opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !reflect.DeepEqual(got, body) {
		t.Fatalf("expected unchanged body for same format")
	}
}

func TestEnsureToolCallIDs_PreservesOriginalWhenSanitizedEmpty(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{
				"role": "assistant",
				"tool_calls": []any{
					map[string]any{
						"id":   "💥💥",
						"type": "function",
						"function": map[string]any{"name": "tool", "arguments": "{}"},
					},
				},
			},
		},
	}
	ensureToolCallIDs(body)
	messages := body["messages"].([]any)
	toolCalls := messages[0].(map[string]any)["tool_calls"].([]any)
	if got := toolCalls[0].(map[string]any)["id"]; got != "💥💥" {
		t.Fatalf("expected original id preserved, got %#v", got)
	}
}

func TestGenerateToolCallID_UniqueWithEmptyName(t *testing.T) {
	first := generateToolCallID(1, 2, "")
	second := generateToolCallID(1, 2, "")
	if first == second {
		t.Fatalf("expected unique tool call IDs, got identical %q", first)
	}
	if !strings.HasPrefix(first, "call_msg1_tc2_") {
		t.Fatalf("expected stable prefix, got %q", first)
	}
}

func TestStringifyToolResult_PrimitivesAndObjects(t *testing.T) {
	cases := map[string]struct {
		input any
		want  string
	}{
		"bool":   {input: true, want: "true"},
		"number": {input: 42, want: "42"},
		"object": {input: map[string]any{"ok": true}, want: `{"ok":true}`},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := stringifyToolResult(tc.input); got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}

func TestTranslateRequest_OpenAIToClaude(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "Hello"},
		},
	}
	opts := TranslateOptions{Model: "claude-sonnet-4", Stream: true, Provider: "claude-cli"}

	got, err := TranslateRequest(FormatOpenAI, FormatClaude, body, opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, ok := got["system"]; !ok {
		t.Fatalf("expected system field in Claude format")
	}
	if got["model"] != "claude-sonnet-4" {
		t.Fatalf("expected model to be set")
	}
}

func TestTranslateRequest_ClaudeToOpenAI(t *testing.T) {
	body := map[string]any{
		"model": "claude-sonnet-4",
		"messages": []any{
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "text", "text": "Hello"},
				},
			},
		},
		"system": "You are helpful",
	}
	opts := TranslateOptions{Model: "gpt-4", Stream: true}

	got, err := TranslateRequest(FormatClaude, FormatOpenAI, body, opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	messages := got["messages"].([]any)
	if len(messages) < 2 {
		t.Fatalf("expected system + user messages")
	}

	firstMsg := messages[0].(map[string]any)
	if firstMsg["role"] != "system" {
		t.Fatalf("expected system message first")
	}
}

func TestTranslateRequest_OpenAIToGemini(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "Hello"},
		},
	}
	opts := TranslateOptions{Model: "gemini-2.5-pro", Stream: true}

	got, err := TranslateRequest(FormatOpenAI, FormatGemini, body, opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, ok := got["contents"]; !ok {
		t.Fatalf("expected contents field in Gemini format")
	}
	if _, ok := got["safetySettings"]; !ok {
		t.Fatalf("expected safetySettings in Gemini format")
	}
}

func TestTranslateRequest_StripImages(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "text", "text": "Hello"},
					map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,abc"}},
				},
			},
		},
	}
	opts := TranslateOptions{
		Model:     "gpt-4",
		Stream:    true,
		StripList: []string{"image"},
	}

	got, err := TranslateRequest(FormatOpenAI, FormatOpenAI, body, opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	messages := got["messages"].([]any)
	msg := messages[0].(map[string]any)
	content := msg["content"].([]any)

	if len(content) != 1 {
		t.Fatalf("expected 1 content part after stripping, got %d", len(content))
	}
	if content[0].(map[string]any)["type"] != "text" {
		t.Fatalf("expected text part to remain")
	}
}

func TestTranslateRequest_RemovesMessagesWithOnlyStrippedContent(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,abc"}},
				},
			},
			map[string]any{"role": "user", "content": "keep me"},
		},
	}
	opts := TranslateOptions{Model: "gpt-4", Stream: true, StripList: []string{"image"}}

	got, err := TranslateRequest(FormatOpenAI, FormatOpenAI, body, opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	messages := got["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("expected stripped-only message to be removed, got %d messages", len(messages))
	}
}

func TestTranslateRequest_RejectsEmptyMessages(t *testing.T) {
	body := map[string]any{"messages": []any{}}
	_, err := TranslateRequest(FormatOpenAI, FormatOpenAI, body, TranslateOptions{Model: "gpt-4", Stream: true})
	if err == nil || !strings.Contains(err.Error(), "messages array must not be empty") {
		t.Fatalf("expected clear empty messages error, got %v", err)
	}
}
