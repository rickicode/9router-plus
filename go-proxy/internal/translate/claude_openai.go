package translate

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"
)

func ClaudeToOpenAIChunk(chunk []byte, state *StreamState) ([]byte, error) {
	if len(chunk) == 0 {
		return nil, nil
	}
	if state == nil {
		return nil, fmt.Errorf("stream state is required")
	}
	if state.ToolCalls == nil {
		state.ToolCalls = make(map[int]*ToolCall)
	}

	var event map[string]any
	if err := json.Unmarshal(chunk, &event); err != nil {
		return nil, fmt.Errorf("unmarshal claude chunk: %w", err)
	}

	result := handleClaudeEvent(event, state)
	if result == nil {
		return nil, nil
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("marshal openai chunk: %w", err)
	}
	return encoded, nil
}

func handleClaudeEvent(event map[string]any, state *StreamState) map[string]any {
	switch stringValue(event["type"]) {
	case "message_start":
		message, _ := event["message"].(map[string]any)
		state.MessageID = valueOrDefault(stringValue(message["id"]), fmt.Sprintf("msg_%d", time.Now().UnixMilli()))
		state.Model = stringValue(message["model"])
		state.ToolCallIndex = 0
		if state.ToolCalls == nil {
			state.ToolCalls = make(map[int]*ToolCall)
		}
		return createOpenAIChunk(state, map[string]any{"role": "assistant"}, nil)

	case "content_block_start":
		block, _ := event["content_block"].(map[string]any)
		index := intValue(event["index"], 0)
		if index < 0 {
			log.Printf("translate: ignoring negative Claude content block index %d", index)
			return nil
		}
		if index > 100 {
			log.Printf("translate: suspicious Claude content block index %d", index)
		}
		switch stringValue(block["type"]) {
		case "server_tool_use":
			state.ServerToolBlockIndex = index
			state.ServerToolBlockActive = true
			return nil
		case "text":
			state.TextBlockStarted = true
			return nil
		case "thinking":
			state.InThinkingBlock = true
			state.CurrentBlockIndex = index
			return createOpenAIChunk(state, map[string]any{"content": "<think>"}, nil)
		case "tool_use":
			if state.ToolCalls == nil {
				state.ToolCalls = make(map[int]*ToolCall)
			}
			toolName := stringValue(block["name"])
			if state.ToolNameMap != nil {
				if original, ok := state.ToolNameMap[toolName]; ok && original != "" {
					toolName = original
				}
			}
			toolCall := &ToolCall{
				Index: state.ToolCallIndex,
				ID:    stringValue(block["id"]),
				Type:  "function",
				Function: map[string]any{
					"name":      toolName,
					"arguments": "",
				},
			}
			state.ToolCallIndex++
			state.ToolCalls[index] = toolCall
			return createOpenAIChunk(state, map[string]any{
				"tool_calls": []any{map[string]any{
					"index": toolCall.Index,
					"id":    toolCall.ID,
					"type":  toolCall.Type,
					"function": map[string]any{
						"name":      toolName,
						"arguments": "",
					},
				}},
			}, nil)
		}

	case "content_block_delta":
		index := intValue(event["index"], 0)
		if index < 0 {
			log.Printf("translate: ignoring negative Claude delta index %d", index)
			return nil
		}
		if index > 100 {
			log.Printf("translate: suspicious Claude delta index %d", index)
		}
		if state.ServerToolBlockActive && index == state.ServerToolBlockIndex {
			return nil
		}
		delta, _ := event["delta"].(map[string]any)
		switch stringValue(delta["type"]) {
		case "text_delta":
			if text := stringValue(delta["text"]); text != "" {
				return createOpenAIChunk(state, map[string]any{"content": text}, nil)
			}
		case "thinking_delta":
			if thinking := stringValue(delta["thinking"]); thinking != "" {
				return createOpenAIChunk(state, map[string]any{"reasoning_content": thinking}, nil)
			}
		case "input_json_delta":
			if partial := stringValue(delta["partial_json"]); partial != "" {
				if !json.Valid([]byte(partial)) && !isLikelyPartialJSONObject(partial) {
					log.Printf("translate: skipping malformed Claude input_json_delta for index %d", index)
					return nil
				}
				if state.ToolCalls == nil {
					state.ToolCalls = make(map[int]*ToolCall)
				}
				if toolCall := state.ToolCalls[index]; toolCall != nil {
					if toolCall.Function == nil {
						toolCall.Function = map[string]any{"arguments": ""}
					}
					current, _ := toolCall.Function["arguments"].(string)
					toolCall.Function["arguments"] = current + partial
					return createOpenAIChunk(state, map[string]any{
						"tool_calls": []any{map[string]any{
							"index": toolCall.Index,
							"id":    toolCall.ID,
							"function": map[string]any{"arguments": partial},
						}},
					}, nil)
				}
			}
		}

	case "content_block_stop":
		index := intValue(event["index"], 0)
		if index < 0 {
			log.Printf("translate: ignoring negative Claude stop index %d", index)
			return nil
		}
		if index > 100 {
			log.Printf("translate: suspicious Claude stop index %d", index)
		}
		if state.ServerToolBlockActive && index == state.ServerToolBlockIndex {
			state.ServerToolBlockIndex = 0
			state.ServerToolBlockActive = false
			return nil
		}
		if state.InThinkingBlock && index == state.CurrentBlockIndex {
			state.InThinkingBlock = false
			return createOpenAIChunk(state, map[string]any{"content": "</think>"}, nil)
		}
		state.TextBlockStarted = false
		state.ThinkingBlockStarted = false
		return nil

	case "message_delta":
		if usage, ok := event["usage"].(map[string]any); ok {
			inputTokens := intValue(usage["input_tokens"], 0)
			outputTokens := intValue(usage["output_tokens"], 0)
			cacheReadTokens := intValue(usage["cache_read_input_tokens"], 0)
			cacheCreateTokens := intValue(usage["cache_creation_input_tokens"], 0)
			promptTokens := inputTokens + cacheReadTokens + cacheCreateTokens
			state.Usage = map[string]any{
				"prompt_tokens":     promptTokens,
				"completion_tokens": outputTokens,
				"total_tokens":      promptTokens + outputTokens,
				"input_tokens":      inputTokens,
				"output_tokens":     outputTokens,
			}
			if cacheReadTokens > 0 {
				state.Usage["cache_read_input_tokens"] = cacheReadTokens
			}
			if cacheCreateTokens > 0 {
				state.Usage["cache_creation_input_tokens"] = cacheCreateTokens
			}
		}
		delta, _ := event["delta"].(map[string]any)
		if stopReason := stringValue(delta["stop_reason"]); stopReason != "" {
			state.FinishReason = convertClaudeStopReason(stopReason)
			final := createOpenAIChunk(state, map[string]any{}, state.FinishReason)
			if state.Usage != nil {
				usage := map[string]any{
					"prompt_tokens":     state.Usage["prompt_tokens"],
					"completion_tokens": state.Usage["completion_tokens"],
					"total_tokens":      state.Usage["total_tokens"],
				}
				cacheRead := intValue(state.Usage["cache_read_input_tokens"], 0)
				cacheCreate := intValue(state.Usage["cache_creation_input_tokens"], 0)
				if cacheRead > 0 || cacheCreate > 0 {
					details := map[string]any{}
					if cacheRead > 0 {
						details["cached_tokens"] = cacheRead
					}
					if cacheCreate > 0 {
						details["cache_creation_tokens"] = cacheCreate
					}
					usage["prompt_tokens_details"] = details
				}
				final["usage"] = usage
			}
			state.FinishReasonSent = true
			return final
		}

	case "message_stop":
		if state.FinishReasonSent {
			return nil
		}
		finishReason := state.FinishReason
		if finishReason == "" {
			if len(state.ToolCalls) > 0 {
				finishReason = "tool_calls"
			} else {
				finishReason = "stop"
			}
		}
		final := createOpenAIChunk(state, map[string]any{}, finishReason)
		if state.Usage != nil {
			final["usage"] = map[string]any{
				"prompt_tokens":     intValue(state.Usage["input_tokens"], 0),
				"completion_tokens": intValue(state.Usage["output_tokens"], 0),
				"total_tokens":      intValue(state.Usage["input_tokens"], 0) + intValue(state.Usage["output_tokens"], 0),
			}
		}
		state.FinishReasonSent = true
		return final
	}

	return nil
}

func isLikelyPartialJSONObject(value string) bool {
	trimmed := value
	if trimmed == "" {
		return false
	}
	return strings.ContainsAny(trimmed, "{}[]:\"") || strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[")
}

func createOpenAIChunk(state *StreamState, delta map[string]any, finishReason any) map[string]any {
	return map[string]any{
		"id":      fmt.Sprintf("chatcmpl-%s", state.MessageID),
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   state.Model,
		"choices": []any{map[string]any{
			"index":         0,
			"delta":         delta,
			"finish_reason": finishReason,
		}},
	}
}

func convertClaudeStopReason(reason string) string {
	switch reason {
	case "end_turn", "stop_sequence":
		return "stop"
	case "max_tokens":
		return "length"
	case "tool_use":
		return "tool_calls"
	default:
		return "stop"
	}
}
