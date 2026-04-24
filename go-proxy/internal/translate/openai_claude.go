package translate

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
)

const (
	defaultMaxTokens   = 64000
	defaultMinTokens   = 32000
	claudeSystemPrompt = "You are Claude Code, Anthropic's official CLI for Claude."
	anthropicVersion   = "2023-06-01"
)

// OpenAIToClaudeRequest converts an OpenAI chat completion request body into Claude messages format.
func OpenAIToClaudeRequest(model string, body map[string]any, stream bool, opts TranslateOptions) (map[string]any, error) {
	result := map[string]any{
		"model":             model,
		"max_tokens":        adjustMaxTokens(body),
		"stream":            stream,
		"anthropic_version": anthropicVersion,
	}

	if temperature, ok := body["temperature"]; ok {
		result["temperature"] = temperature
	}

	toolNameMap := map[string]string{}
	systemParts := []string{}
	resultMessages := []any{}

	if rawMessages, ok := body["messages"].([]any); ok {
		for _, raw := range rawMessages {
			msg, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if msg["role"] == "system" {
				systemParts = append(systemParts, extractTextContent(msg["content"]))
			}
		}
		if len(systemParts) > 5 {
			log.Printf("translate: received %d system messages; joining them with newlines for Claude system blocks", len(systemParts))
		}

		nonSystem := []map[string]any{}
		for _, raw := range rawMessages {
			msg, ok := raw.(map[string]any)
			if !ok || msg["role"] == "system" {
				continue
			}
			nonSystem = append(nonSystem, msg)
		}

		var currentRole string
		currentParts := []any{}
		flush := func() {
			if currentRole != "" && len(currentParts) > 0 {
				resultMessages = append(resultMessages, map[string]any{"role": currentRole, "content": currentParts})
				currentParts = []any{}
			}
		}

		for _, msg := range nonSystem {
			newRole := "assistant"
			if role, _ := msg["role"].(string); role == "user" || role == "tool" {
				newRole = "user"
			}

			blocks, err := getContentBlocksFromMessage(msg, toolNameMap)
			if err != nil {
				return nil, err
			}

			hasToolUse := false
			hasToolResult := false
			toolResultBlocks := []any{}
			otherBlocks := []any{}
			for _, rawBlock := range blocks {
				block, _ := rawBlock.(map[string]any)
				switch block["type"] {
				case "tool_use":
					hasToolUse = true
					otherBlocks = append(otherBlocks, block)
				case "tool_result":
					hasToolResult = true
					toolResultBlocks = append(toolResultBlocks, block)
				default:
					otherBlocks = append(otherBlocks, block)
				}
			}

			if hasToolResult {
				flush()
				if len(toolResultBlocks) > 0 {
					resultMessages = append(resultMessages, map[string]any{"role": "user", "content": toolResultBlocks})
				}
				if len(otherBlocks) > 0 {
					currentRole = newRole
					currentParts = append(currentParts, otherBlocks...)
				}
				continue
			}

			if currentRole != newRole || (hasToolUse && newRole != "assistant") {
				flush()
				if hasToolUse {
					currentRole = "assistant"
				} else {
					currentRole = newRole
				}
			}
			currentParts = append(currentParts, otherBlocks...)

			if hasToolUse {
				flush()
			}
		}
		flush()
		addCacheControlToLastAssistant(resultMessages)
	}
	result["messages"] = resultMessages

	if responseFormat, ok := body["response_format"].(map[string]any); ok {
		switch responseFormat["type"] {
		case "json_object":
			systemParts = append(systemParts, "You must respond with valid JSON. Respond ONLY with a JSON object, no other text.")
		case "json_schema":
			if jsonSchema, ok := responseFormat["json_schema"].(map[string]any); ok {
				if schema, ok := jsonSchema["schema"]; ok {
					schemaJSON, err := json.Marshal(schema)
					if err != nil {
						return nil, fmt.Errorf("marshal response schema: %w", err)
					}
					systemParts = append(systemParts, "You must respond with valid JSON that strictly follows this JSON schema:\n```json\n"+string(schemaJSON)+"\n```\nRespond ONLY with the JSON object, no other text.")
				}
			}
		}
	}

	shouldInjectClaudePrompt := opts.InjectClaudePrompt || strings.Contains(strings.ToLower(opts.Provider), "cli")
	systemBlocks := make([]any, 0, 2)
	if shouldInjectClaudePrompt {
		systemBlocks = append(systemBlocks, map[string]any{"type": "text", "text": claudeSystemPrompt})
	}
	if len(systemParts) > 0 {
		systemBlocks = append(systemBlocks, map[string]any{"type": "text", "text": strings.Join(systemParts, "\n"), "cache_control": map[string]any{"type": "ephemeral"}})
	}
	if len(systemBlocks) > 0 {
		result["system"] = systemBlocks
	}

	if rawTools, ok := body["tools"].([]any); ok {
		tools := make([]any, 0, len(rawTools))
		for _, rawTool := range rawTools {
			tool, ok := rawTool.(map[string]any)
			if !ok {
				continue
			}
			toolType, _ := tool["type"].(string)
			if toolType != "" && toolType != "function" {
				tools = append(tools, tool)
				continue
			}

			toolData := tool
			if fn, ok := tool["function"].(map[string]any); ok {
				toolData = fn
			}

			name, _ := toolData["name"].(string)
			toolNameMap[name] = name
			inputSchema, ok := toolData["parameters"]
			if !ok {
				inputSchema, ok = toolData["input_schema"]
			}
			if !ok {
				inputSchema = map[string]any{"type": "object", "properties": map[string]any{}, "required": []any{}}
			}

			tools = append(tools, map[string]any{
				"name":         name,
				"description":  stringValue(toolData["description"]),
				"input_schema": inputSchema,
			})
		}
		if len(tools) > 0 {
			last, ok := tools[len(tools)-1].(map[string]any)
			if ok {
				last["cache_control"] = map[string]any{"type": "ephemeral"}
				result["tools"] = tools
			}
		}
	}

	if toolChoice, ok := body["tool_choice"]; ok {
		result["tool_choice"] = convertOpenAIToolChoice(toolChoice)
	}

	if thinking, ok := body["thinking"].(map[string]any); ok {
		converted := map[string]any{"type": valueOrDefault(stringValue(thinking["type"]), "enabled")}
		if budget, ok := thinking["budget_tokens"]; ok {
			converted["budget_tokens"] = budget
		}
		if maxTokens, ok := thinking["max_tokens"]; ok {
			converted["max_tokens"] = maxTokens
		}
		result["thinking"] = converted
	}

	if len(toolNameMap) > 0 {
		result["_toolNameMap"] = toolNameMap
	}

	return result, nil
}

func getContentBlocksFromMessage(msg map[string]any, toolNameMap map[string]string) ([]any, error) {
	blocks := []any{}
	role, _ := msg["role"].(string)

	switch role {
	case "tool":
		blocks = append(blocks, map[string]any{
			"type":        "tool_result",
			"tool_use_id": msg["tool_call_id"],
			"content":     msg["content"],
		})
	case "user":
		blocks = append(blocks, convertOpenAIContentParts(msg["content"])...)
	case "assistant":
		if contentBlocks := convertAssistantContent(msg["content"]); len(contentBlocks) > 0 {
			blocks = append(blocks, contentBlocks...)
		}
		if toolCalls, ok := msg["tool_calls"].([]any); ok {
			for _, rawToolCall := range toolCalls {
				toolCall, ok := rawToolCall.(map[string]any)
				if !ok || stringValue(toolCall["type"]) != "function" {
					continue
				}
				fn, _ := toolCall["function"].(map[string]any)
				if fn == nil {
					log.Printf("translate: assistant tool call missing function field for Claude request")
					continue
				}
				blocks = append(blocks, map[string]any{
					"type":  "tool_use",
					"id":    toolCall["id"],
					"name":  stringValue(fn["name"]),
					"input": tryParseJSON(fn["arguments"]),
				})
			}
		}
	}

	return blocks, nil
}

func convertOpenAIContentParts(content any) []any {
	blocks := []any{}
	switch value := content.(type) {
	case string:
		if value != "" {
			blocks = append(blocks, map[string]any{"type": "text", "text": value})
		}
	case []any:
		for _, rawPart := range value {
			part, ok := rawPart.(map[string]any)
			if !ok {
				continue
			}
			switch stringValue(part["type"]) {
			case "text":
				if text := stringValue(part["text"]); text != "" {
					blocks = append(blocks, map[string]any{"type": "text", "text": text})
				}
			case "tool_result":
				content := part["content"]
				switch content.(type) {
				case nil, string, []any, map[string]any, bool, float64, float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
				default:
					log.Printf("translate: unsupported Claude tool_result content type %T; stringifying", content)
					content = stringifyToolResult(content)
				}
				block := map[string]any{"type": "tool_result", "tool_use_id": part["tool_use_id"], "content": content}
				if isError, ok := part["is_error"]; ok {
					if boolValue, ok := isError.(bool); ok {
						block["is_error"] = boolValue
					} else {
						log.Printf("translate: skipping non-boolean is_error value of type %T", isError)
					}
				}
				blocks = append(blocks, block)
			case "image_url":
				if imageURL, ok := part["image_url"].(map[string]any); ok {
					if imageURLValue := stringValue(imageURL["url"]); strings.HasPrefix(imageURLValue, "data:") {
						if mediaType, data, ok := parseDataURL(imageURLValue); ok {
							blocks = append(blocks, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": mediaType, "data": data}})
						}
					} else if validatedURL, ok := normalizeImageURL(imageURLValue); ok {
						blocks = append(blocks, map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": validatedURL}})
					}
				}
			case "image":
				if source, ok := part["source"]; ok {
					blocks = append(blocks, map[string]any{"type": "image", "source": source})
				}
			}
		}
	}
	return blocks
}

func convertAssistantContent(content any) []any {
	blocks := []any{}
	switch value := content.(type) {
	case []any:
		for _, rawPart := range value {
			part, ok := rawPart.(map[string]any)
			if !ok {
				continue
			}
			switch stringValue(part["type"]) {
			case "text":
				if text := stringValue(part["text"]); text != "" {
					blocks = append(blocks, map[string]any{"type": "text", "text": text})
				}
			case "tool_use":
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": part["id"], "name": part["name"], "input": part["input"]})
			case "thinking":
				thinkingBlock := map[string]any{}
				for k, v := range part {
					if k == "cache_control" {
						continue
					}
					thinkingBlock[k] = v
				}
				blocks = append(blocks, thinkingBlock)
			}
		}
	default:
		if text := extractTextContent(content); text != "" {
			blocks = append(blocks, map[string]any{"type": "text", "text": text})
		}
	}
	return blocks
}

func convertOpenAIToolChoice(choice any) map[string]any {
	if choice == nil {
		return map[string]any{"type": "auto"}
	}
	if choiceMap, ok := choice.(map[string]any); ok {
		if _, hasType := choiceMap["type"]; hasType {
			return choiceMap
		}
		if fn, ok := choiceMap["function"].(map[string]any); ok {
			return map[string]any{"type": "tool", "name": fn["name"]}
		}
	}
	if choiceStr, ok := choice.(string); ok {
		switch choiceStr {
		case "required":
			return map[string]any{"type": "any"}
		case "auto":
			return map[string]any{"type": "auto"}
		case "none":
			return map[string]any{"type": "none"}
		}
	}
	return map[string]any{"type": "auto"}
}

func normalizeImageURL(raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	if strings.HasPrefix(raw, "file://") {
		log.Printf("translate: rejecting unsupported file image URL %q", raw)
		return "", false
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		log.Printf("translate: rejecting invalid image URL %q: %v", raw, err)
		return "", false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		log.Printf("translate: rejecting unsupported image URL scheme %q", raw)
		return "", false
	}
	if parsed.Host == "" {
		log.Printf("translate: rejecting relative image URL %q", raw)
		return "", false
	}
	return raw, true
}

func extractTextContent(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	parts, ok := content.([]any)
	if !ok {
		return ""
	}
	texts := make([]string, 0, len(parts))
	for _, rawPart := range parts {
		part, ok := rawPart.(map[string]any)
		if !ok || stringValue(part["type"]) != "text" {
			continue
		}
		if text := stringValue(part["text"]); text != "" {
			texts = append(texts, text)
		}
	}
	return strings.Join(texts, "\n")
}

func tryParseJSON(value any) any {
	str, ok := value.(string)
	if !ok {
		return value
	}
	var parsed any
	if err := json.Unmarshal([]byte(str), &parsed); err != nil {
		return str
	}
	return parsed
}

func adjustMaxTokens(body map[string]any) int {
	maxTokens := intValue(body["max_tokens"], defaultMaxTokens)
	if tools, ok := body["tools"].([]any); ok && len(tools) > 0 && maxTokens < defaultMinTokens {
		maxTokens = defaultMinTokens
	}
	if thinking, ok := body["thinking"].(map[string]any); ok {
		budget := intValue(thinking["budget_tokens"], 0)
		if budget > 0 && maxTokens <= budget {
			maxTokens = budget + 1024
		}
	}
	return maxTokens
}

func addCacheControlToLastAssistant(messages []any) {
	for i := len(messages) - 1; i >= 0; i-- {
		msg, ok := messages[i].(map[string]any)
		if !ok || msg["role"] != "assistant" {
			continue
		}
		content, ok := msg["content"].([]any)
		if !ok || len(content) == 0 {
			return
		}
		for j := len(content) - 1; j >= 0; j-- {
			block, ok := content[j].(map[string]any)
			if !ok {
				continue
			}
			switch block["type"] {
			case "text", "tool_use", "tool_result", "image":
				block["cache_control"] = map[string]any{"type": "ephemeral"}
				return
			}
		}
		return
	}
}

func parseDataURL(url string) (string, string, bool) {
	if !strings.HasPrefix(url, "data:") {
		return "", "", false
	}
	parts := strings.SplitN(strings.TrimPrefix(url, "data:"), ";base64,", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func intValue(value any, fallback int) int {
	switch v := value.(type) {
	case int:
		return v
	case int32:
		return int(v)
	case int64:
		return int(v)
	case float64:
		return int(v)
	case float32:
		return int(v)
	default:
		return fallback
	}
}

func stringValue(value any) string {
	if str, ok := value.(string); ok {
		return str
	}
	return ""
}

func valueOrDefault(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
