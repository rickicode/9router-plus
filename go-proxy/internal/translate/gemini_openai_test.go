package translate

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGeminiToOpenAI_TextPart(t *testing.T) {
	state := &StreamState{MessageID: "msg_123", Model: "gemini-2.5-pro"}
	chunk := []byte(`data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"}}]}`)

	got, err := GeminiToOpenAIChunk(chunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(got, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	choices := result["choices"].([]any)
	delta := choices[0].(map[string]any)["delta"].(map[string]any)
	if delta["content"] != "Hello" {
		t.Fatalf("expected content Hello, got %#v", delta["content"])
	}
}

func TestGeminiToOpenAI_ThoughtPart(t *testing.T) {
	state := &StreamState{MessageID: "msg_123", Model: "gemini-2.5-pro"}
	chunk := []byte(`data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"thinking..."}]}}]}`)

	got, err := GeminiToOpenAIChunk(chunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(got, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	choices := result["choices"].([]any)
	delta := choices[0].(map[string]any)["delta"].(map[string]any)

	content := delta["content"].(string)
	if !strings.Contains(content, "<think>") || !strings.Contains(content, "thinking...") {
		t.Fatalf("expected wrapped thinking, got %q", content)
	}
}

func TestGeminiToOpenAI_FunctionCall(t *testing.T) {
	state := &StreamState{
		MessageID: "msg_123",
		Model:     "gemini-2.5-pro",
		ToolCalls: make(map[int]*ToolCall),
	}
	chunk := []byte(`data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_123","name":"get_weather","args":{"city":"SF"}}}]}}]}`)

	got, err := GeminiToOpenAIChunk(chunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(got, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	choices := result["choices"].([]any)
	delta := choices[0].(map[string]any)["delta"].(map[string]any)
	toolCalls := delta["tool_calls"].([]any)
	toolCall := toolCalls[0].(map[string]any)

	if toolCall["id"] != "call_123" {
		t.Fatalf("expected call_123, got %#v", toolCall["id"])
	}
	fn := toolCall["function"].(map[string]any)
	if fn["name"] != "get_weather" {
		t.Fatalf("expected get_weather, got %#v", fn["name"])
	}
	args := fn["arguments"].(string)
	if !strings.Contains(args, "SF") {
		t.Fatalf("expected SF in args, got %q", args)
	}
}

func TestGeminiToOpenAI_FinishReason(t *testing.T) {
	state := &StreamState{MessageID: "msg_123", Model: "gemini-2.5-pro"}
	chunk := []byte(`data: {"candidates":[{"finishReason":"STOP"}]}`)

	got, err := GeminiToOpenAIChunk(chunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(got, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	choices := result["choices"].([]any)
	finishReason := choices[0].(map[string]any)["finish_reason"]
	if finishReason != "stop" {
		t.Fatalf("expected stop, got %#v", finishReason)
	}
}

func TestGeminiToOpenAI_UsageMetadata(t *testing.T) {
	state := &StreamState{MessageID: "msg_123", Model: "gemini-2.5-pro"}
	chunk := []byte(`data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"totalTokenCount":30}}`)

	got, err := GeminiToOpenAIChunk(chunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		var result map[string]any
		if err := json.Unmarshal(got, &result); err != nil {
			t.Fatalf("unmarshal result: %v", err)
		}
	}

	if state.UsageData == nil {
		t.Fatalf("expected usage data to be set")
	}
	if state.UsageData.PromptTokens != 10 {
		t.Fatalf("expected 10 prompt tokens, got %d", state.UsageData.PromptTokens)
	}
	if state.UsageData.CompletionTokens != 20 {
		t.Fatalf("expected 20 completion tokens, got %d", state.UsageData.CompletionTokens)
	}
}

func TestGeminiToOpenAI_UsageMetadataAccumulates(t *testing.T) {
	state := &StreamState{MessageID: "msg_123", Model: "gemini-2.5-pro"}
	chunkOne := []byte(`data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":0,"thoughtsTokenCount":4,"totalTokenCount":18,"cachedContentTokenCount":2}}`)
	chunkTwo := []byte(`data: {"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":7,"thoughtsTokenCount":3,"totalTokenCount":15,"cachedContentTokenCount":1}}`)

	if _, err := GeminiToOpenAIChunk(chunkOne, state); err != nil {
		t.Fatalf("unexpected error on first chunk: %v", err)
	}
	if _, err := GeminiToOpenAIChunk(chunkTwo, state); err != nil {
		t.Fatalf("unexpected error on second chunk: %v", err)
	}

	if state.UsageData == nil {
		t.Fatalf("expected usage data to be set")
	}
	if state.UsageData.PromptTokens != 15 {
		t.Fatalf("expected accumulated prompt tokens 15, got %d", state.UsageData.PromptTokens)
	}
	if state.UsageData.CompletionTokens != 18 {
		t.Fatalf("expected accumulated completion tokens 18, got %d", state.UsageData.CompletionTokens)
	}
	if state.UsageData.TotalTokens != 33 {
		t.Fatalf("expected accumulated total tokens 33, got %d", state.UsageData.TotalTokens)
	}
	promptDetails := state.Usage["prompt_tokens_details"].(map[string]any)
	if promptDetails["cached_tokens"] != 3 {
		t.Fatalf("expected cached tokens 3, got %#v", promptDetails)
	}
	completionDetails := state.Usage["completion_tokens_details"].(map[string]any)
	if completionDetails["reasoning_tokens"] != 7 {
		t.Fatalf("expected reasoning tokens 7, got %#v", completionDetails)
	}
}

func TestGeminiToOpenAI_FunctionCallInitializesNilToolCallsMap(t *testing.T) {
	state := &StreamState{MessageID: "msg_123", Model: "gemini-2.5-pro"}
	chunk := []byte(`data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_123","name":"get_weather","args":{"city":"SF"}}}]}}]}`)
	if _, err := GeminiToOpenAIChunk(chunk, state); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if state.ToolCalls == nil {
		t.Fatalf("expected ToolCalls map to be initialized")
	}
}
