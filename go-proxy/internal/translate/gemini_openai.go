package translate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"
)

func GeminiToOpenAIChunk(chunk []byte, state *StreamState) ([]byte, error) {
	if len(bytes.TrimSpace(chunk)) == 0 {
		return nil, nil
	}
	if state == nil {
		return nil, fmt.Errorf("stream state is required")
	}
	if state.ToolCalls == nil {
		state.ToolCalls = make(map[int]*ToolCall)
	}

	payload, ok := extractSSEData(chunk)
	if !ok {
		return nil, nil
	}

	var response map[string]any
	if err := json.Unmarshal(payload, &response); err != nil {
		return nil, fmt.Errorf("unmarshal gemini chunk: %w", err)
	}

	if wrapped, ok := response["response"].(map[string]any); ok {
		response = wrapped
	}

	if !initializeGeminiState(response, state) {
		return nil, nil
	}

	if usageMeta, ok := response["usageMetadata"].(map[string]any); ok {
		updateGeminiUsage(usageMeta, state)
	}

	candidate := firstCandidate(response)
	if candidate == nil {
		return nil, nil
	}

	if content, ok := candidate["content"].(map[string]any); ok {
		if result, ok := translateGeminiParts(content["parts"], state); ok {
			return json.Marshal(result)
		}
	}

	if finishReason := stringValue(candidate["finishReason"]); finishReason != "" {
		result := createOpenAIChunk(state, map[string]any{}, convertGeminiFinishReason(finishReason, state))
		if state.Usage != nil {
			result["usage"] = state.Usage
		}
		return json.Marshal(result)
	}

	return nil, nil

}

func extractSSEData(chunk []byte) ([]byte, bool) {
	trimmed := bytes.TrimSpace(chunk)
	if bytes.Equal(trimmed, []byte("data: [DONE]")) || bytes.Equal(trimmed, []byte("[DONE]")) {
		return nil, false
	}
	if bytes.HasPrefix(trimmed, []byte("data:")) {
		trimmed = bytes.TrimSpace(trimmed[len("data:"):])
	}
	if len(trimmed) == 0 {
		return nil, false
	}
	return trimmed, true
}

func initializeGeminiState(response map[string]any, state *StreamState) bool {
	if state.MessageID != "" {
		return true
	}
	if firstCandidate(response) == nil {
		return false
	}
	state.MessageID = valueOrDefault(stringValue(response["responseId"]), fmt.Sprintf("msg_%d", time.Now().UnixMilli()))
	state.Model = valueOrDefault(stringValue(response["modelVersion"]), valueOrDefault(state.Model, "gemini"))
	state.ToolCallIndex = 0
	if state.ToolCalls == nil {
		state.ToolCalls = make(map[int]*ToolCall)
	}
	return true
}

func firstCandidate(response map[string]any) map[string]any {
	candidates, ok := response["candidates"].([]any)
	if !ok || len(candidates) == 0 {
		return nil
	}
	candidate, _ := candidates[0].(map[string]any)
	return candidate
}

func translateGeminiParts(rawParts any, state *StreamState) (map[string]any, bool) {
	parts, ok := rawParts.([]any)
	if !ok {
		return nil, false
	}
	for _, rawPart := range parts {
		part, ok := rawPart.(map[string]any)
		if !ok {
			continue
		}

		if functionCall, ok := part["functionCall"].(map[string]any); ok {
			if chunk := createGeminiToolCallChunk(functionCall, state); chunk != nil {
				return chunk, true
			}
			return nil, false
		}

		text := stringValue(part["text"])
		if text == "" {
			continue
		}
		if part["thought"] == true {
			return createOpenAIChunk(state, map[string]any{"content": "<think>" + text + "</think>"}, nil), true
		}
		return createOpenAIChunk(state, map[string]any{"content": text}, nil), true
	}
	return nil, false
}

func createGeminiToolCallChunk(functionCall map[string]any, state *StreamState) map[string]any {
	if state.ToolCalls == nil {
		state.ToolCalls = make(map[int]*ToolCall)
	}
	name := stringValue(functionCall["name"])
	if state.ToolNameMap != nil {
		if original, ok := state.ToolNameMap[name]; ok && original != "" {
			name = original
		}
	}
	arguments, _ := json.Marshal(functionCall["args"])
	if !json.Valid(arguments) {
		log.Printf("translate: skipping malformed Gemini function args for %q", name)
		return nil
	}
	id := valueOrDefault(stringValue(functionCall["id"]), fmt.Sprintf("%s-%d-%d", name, time.Now().UnixMilli(), state.ToolCallIndex))
	toolCall := &ToolCall{
		Index: state.ToolCallIndex,
		ID:    id,
		Type:  "function",
		Function: map[string]any{
			"name":      name,
			"arguments": string(arguments),
		},
	}
	state.ToolCalls[state.ToolCallIndex] = toolCall
	state.ToolCallIndex++
	return createOpenAIChunk(state, map[string]any{
		"tool_calls": []any{map[string]any{
			"index": toolCall.Index,
			"id":    toolCall.ID,
			"type":  toolCall.Type,
			"function": map[string]any{
				"name":      name,
				"arguments": string(arguments),
			},
		}},
	}, nil)
}

func updateGeminiUsage(usageMeta map[string]any, state *StreamState) {
	promptTokens := intValue(usageMeta["promptTokenCount"], 0)
	thoughtsTokens := intValue(usageMeta["thoughtsTokenCount"], 0)
	candidateTokens := intValue(usageMeta["candidatesTokenCount"], 0)
	completionTokens := candidateTokens + thoughtsTokens
	totalTokens := intValue(usageMeta["totalTokenCount"], 0)
	if candidateTokens == 0 && totalTokens > 0 {
		completionTokens = totalTokens - promptTokens
		if completionTokens < 0 {
			completionTokens = 0
		}
	}
	if state.UsageData == nil {
		state.UsageData = &UsageData{}
	}
	state.UsageData.PromptTokens += promptTokens
	state.UsageData.CompletionTokens += completionTokens
	state.UsageData.TotalTokens += totalTokens
	cachedTokens := intValue(usageMeta["cachedContentTokenCount"], 0)
	existingCachedTokens := 0
	existingReasoningTokens := 0
	if state.Usage != nil {
		existingCachedTokens = intValue(nestedMapValue(state.Usage, "prompt_tokens_details", "cached_tokens"), 0)
		existingReasoningTokens = intValue(nestedMapValue(state.Usage, "completion_tokens_details", "reasoning_tokens"), 0)
	}
	state.Usage = map[string]any{
		"prompt_tokens":     state.UsageData.PromptTokens,
		"completion_tokens": state.UsageData.CompletionTokens,
		"total_tokens":      state.UsageData.TotalTokens,
	}
	if totalCachedTokens := existingCachedTokens + cachedTokens; totalCachedTokens > 0 {
		state.Usage["prompt_tokens_details"] = map[string]any{"cached_tokens": totalCachedTokens}
	}
	if totalReasoningTokens := existingReasoningTokens + thoughtsTokens; totalReasoningTokens > 0 {
		state.Usage["completion_tokens_details"] = map[string]any{"reasoning_tokens": totalReasoningTokens}
	}
}

func nestedMapValue(value map[string]any, keys ...string) any {
	current := any(value)
	for _, key := range keys {
		m, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = m[key]
	}
	return current
}

func convertGeminiFinishReason(reason string, state *StreamState) string {
	switch strings.ToUpper(reason) {
	case "STOP":
		if len(state.ToolCalls) > 0 {
			return "tool_calls"
		}
		return "stop"
	case "MAX_TOKENS":
		return "length"
	case "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII":
		return "content_filter"
	case "MALFORMED_FUNCTION_CALL":
		return "tool_calls"
	default:
		return strings.ToLower(reason)
	}
}
