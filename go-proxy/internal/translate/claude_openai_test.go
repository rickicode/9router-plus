package translate

import (
	"encoding/json"
	"testing"
)

func TestClaudeToOpenAI_MessageStart(t *testing.T) {
	chunk := []byte(`{"type":"message_start","message":{"id":"msg_123","model":"claude-sonnet-4"}}`)
	state := &StreamState{}

	got, err := ClaudeToOpenAIChunk(chunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if state.MessageID != "msg_123" {
		t.Fatalf("expected message ID msg_123, got %q", state.MessageID)
	}

	var result map[string]any
	if err := json.Unmarshal(got, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	choices := result["choices"].([]any)
	delta := choices[0].(map[string]any)["delta"].(map[string]any)
	if delta["role"] != "assistant" {
		t.Fatalf("expected assistant role, got %#v", delta["role"])
	}
}

func TestClaudeToOpenAI_TextDelta(t *testing.T) {
	state := &StreamState{MessageID: "msg_123", Model: "claude-sonnet-4"}
	chunk := []byte(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`)

	got, err := ClaudeToOpenAIChunk(chunk, state)
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

func TestClaudeToOpenAI_ThinkingBlock(t *testing.T) {
	state := &StreamState{MessageID: "msg_123", Model: "claude-sonnet-4"}

	startChunk := []byte(`{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}`)
	got, err := ClaudeToOpenAIChunk(startChunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(got, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	choices := result["choices"].([]any)
	delta := choices[0].(map[string]any)["delta"].(map[string]any)
	if delta["content"] != "<think>" {
		t.Fatalf("expected <think>, got %#v", delta["content"])
	}

	deltaChunk := []byte(`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoning..."}}`)
	got, err = ClaudeToOpenAIChunk(deltaChunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if err := json.Unmarshal(got, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	choices = result["choices"].([]any)
	delta = choices[0].(map[string]any)["delta"].(map[string]any)
	if delta["reasoning_content"] != "reasoning..." {
		t.Fatalf("expected reasoning_content, got %#v", delta)
	}

	stopChunk := []byte(`{"type":"content_block_stop","index":0}`)
	got, err = ClaudeToOpenAIChunk(stopChunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if err := json.Unmarshal(got, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	choices = result["choices"].([]any)
	delta = choices[0].(map[string]any)["delta"].(map[string]any)
	if delta["content"] != "</think>" {
		t.Fatalf("expected </think>, got %#v", delta["content"])
	}
}

func TestClaudeToOpenAI_ToolCall(t *testing.T) {
	state := &StreamState{
		MessageID: "msg_123",
		Model:     "claude-sonnet-4",
		ToolCalls: make(map[int]*ToolCall),
	}

	startChunk := []byte(`{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_123","name":"get_weather"}}`)
	got, err := ClaudeToOpenAIChunk(startChunk, state)
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
	if toolCall["function"].(map[string]any)["name"] != "get_weather" {
		t.Fatalf("expected get_weather, got %#v", toolCall["function"])
	}

	deltaChunk := []byte(`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}`)
	got, err = ClaudeToOpenAIChunk(deltaChunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if err := json.Unmarshal(got, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	choices = result["choices"].([]any)
	delta = choices[0].(map[string]any)["delta"].(map[string]any)
	toolCalls = delta["tool_calls"].([]any)
	toolCall = toolCalls[0].(map[string]any)
	fn := toolCall["function"].(map[string]any)
	if fn["arguments"] != "{\"city\":" {
		t.Fatalf("expected partial args, got %#v", fn["arguments"])
	}
}

func TestClaudeToOpenAI_MessageStop(t *testing.T) {
	state := &StreamState{MessageID: "msg_123", Model: "claude-sonnet-4"}
	chunk := []byte(`{"type":"message_stop"}`)

	got, err := ClaudeToOpenAIChunk(chunk, state)
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
		t.Fatalf("expected stop finish_reason, got %#v", finishReason)
	}
}

func TestClaudeToOpenAI_InputJSONDeltaInitializesMissingFunction(t *testing.T) {
	state := &StreamState{
		MessageID: "msg_123",
		Model:     "claude-sonnet-4",
		ToolCalls: map[int]*ToolCall{0: {Index: 0, ID: "call_123", Type: "function"}},
	}
	chunk := []byte(`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"SF\"}"}}`)

	got, err := ClaudeToOpenAIChunk(chunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got == nil {
		t.Fatalf("expected chunk output")
	}
	if state.ToolCalls[0].Function["arguments"] != `{"city":"SF"}` {
		t.Fatalf("expected arguments to be initialized and accumulated, got %#v", state.ToolCalls[0].Function)
	}
}

func TestClaudeToOpenAI_NegativeIndexIgnored(t *testing.T) {
	state := &StreamState{MessageID: "msg_123", Model: "claude-sonnet-4", ToolCalls: make(map[int]*ToolCall)}
	chunk := []byte(`{"type":"content_block_delta","index":-1,"delta":{"type":"input_json_delta","partial_json":"{}"}}`)

	got, err := ClaudeToOpenAIChunk(chunk, state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Fatalf("expected negative index chunk to be ignored, got %s", string(got))
	}
}

func TestClaudeToOpenAI_InputJSONDeltaInitializesNilToolCallsMap(t *testing.T) {
	state := &StreamState{MessageID: "msg_123", Model: "claude-sonnet-4"}
	startChunk := []byte(`{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_123","name":"get_weather"}}`)
	if _, err := ClaudeToOpenAIChunk(startChunk, state); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if state.ToolCalls == nil {
		t.Fatalf("expected ToolCalls map to be initialized")
	}
}
