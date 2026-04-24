package translate

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"time"
)

type TranslateOptions struct {
	Model              string
	Stream             bool
	StripList          []string
	Provider           string
	InjectClaudePrompt bool
	SafetySettings     []map[string]any
}

// TranslateRequest translates a request body through the OpenAI intermediate format when needed.
func TranslateRequest(sourceFormat, targetFormat string, body map[string]any, opts TranslateOptions) (map[string]any, error) {
	result, err := cloneMap(body)
	if err != nil {
		return nil, err
	}

	if err := validateMessages(result); err != nil {
		return nil, err
	}

	stripContentTypes(result, opts.StripList)
	ensureToolCallIDs(result)
	fixMissingToolResponses(result)

	if err := validateMessages(result); err != nil {
		return nil, err
	}

	if sourceFormat != targetFormat {
		if sourceFormat != FormatOpenAI {
			result, err = toOpenAIRequest(sourceFormat, opts.Model, result, opts.Stream)
			if err != nil {
				return nil, err
			}
		}

		if targetFormat != FormatOpenAI {
			result, err = fromOpenAIRequest(targetFormat, opts.Model, result, opts)
			if err != nil {
				return nil, err
			}
		}
	}

	if sourceFormat != targetFormat && targetFormat == FormatOpenAI {
		result = filterToOpenAIFormat(result)
	}

	return result, nil
}

func toOpenAIRequest(sourceFormat, model string, body map[string]any, stream bool) (map[string]any, error) {
	switch sourceFormat {
	case FormatClaude:
		return ClaudeToOpenAIRequest(model, body, stream)
	case FormatGemini, FormatGeminiCLI:
		return GeminiToOpenAIRequest(model, body, stream)
	default:
		return body, nil
	}
}

func fromOpenAIRequest(targetFormat, model string, body map[string]any, opts TranslateOptions) (map[string]any, error) {
	switch targetFormat {
	case FormatClaude:
		return OpenAIToClaudeRequest(model, body, opts.Stream, opts)
	case FormatGemini, FormatGeminiCLI:
		return OpenAIToGeminiRequest(model, body, opts.Stream, opts)
	default:
		return body, nil
	}
}

func ClaudeToOpenAIRequest(model string, body map[string]any, stream bool) (map[string]any, error) {
	result := map[string]any{
		"model":    model,
		"messages": []any{},
		"stream":   stream,
	}

	if body["max_tokens"] != nil {
		result["max_tokens"] = adjustMaxTokens(body)
	}
	if temperature, ok := body["temperature"]; ok {
		result["temperature"] = temperature
	}

	if body["system"] != nil {
		systemContent := extractClaudeSystemText(body["system"])
		if systemContent != "" {
			result["messages"] = append(result["messages"].([]any), map[string]any{
				"role":    "system",
				"content": systemContent,
			})
		}
	}

	if rawMessages, ok := body["messages"].([]any); ok {
		messages, ok := result["messages"].([]any)
		if !ok {
			return nil, fmt.Errorf("messages is not a slice")
		}
		for _, raw := range rawMessages {
			msg, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			converted := convertClaudeMessage(msg)
			switch v := converted.(type) {
			case nil:
			case []any:
				messages = append(messages, v...)
			case map[string]any:
				messages = append(messages, v)
			}
		}
		result["messages"] = messages
	}

	fixMissingToolResponses(result)

	if rawTools, ok := body["tools"].([]any); ok {
		tools := []any{}
		for _, raw := range rawTools {
			tool, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			tools = append(tools, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        tool["name"],
					"description": stringValue(tool["description"]),
					"parameters":  valueOrDefaultMap(tool["input_schema"]),
				},
			})
		}
		if len(tools) > 0 {
			result["tools"] = tools
		}
	}

	if toolChoice, ok := body["tool_choice"]; ok {
		result["tool_choice"] = convertClaudeToolChoice(toolChoice)
	}

	return result, nil
}

func GeminiToOpenAIRequest(model string, body map[string]any, stream bool) (map[string]any, error) {
	result := map[string]any{
		"model":    model,
		"messages": []any{},
		"stream":   stream,
	}

	if generationConfig, ok := body["generationConfig"].(map[string]any); ok {
		if maxOutputTokens, ok := generationConfig["maxOutputTokens"]; ok {
			result["max_tokens"] = adjustMaxTokens(map[string]any{"max_tokens": maxOutputTokens, "tools": body["tools"]})
		}
		if temperature, ok := generationConfig["temperature"]; ok {
			result["temperature"] = temperature
		}
		if topP, ok := generationConfig["topP"]; ok {
			result["top_p"] = topP
		}
	}

	if systemInstruction, ok := body["systemInstruction"]; ok {
		if systemText := extractGeminiText(systemInstruction); systemText != "" {
			result["messages"] = append(result["messages"].([]any), map[string]any{
				"role":    "system",
				"content": systemText,
			})
		}
	}

	if rawContents, ok := body["contents"].([]any); ok {
		messages, ok := result["messages"].([]any)
		if !ok {
			return nil, fmt.Errorf("messages is not a slice")
		}
		for _, raw := range rawContents {
			content, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if converted := convertGeminiContent(content); converted != nil {
				messages = append(messages, converted)
			}
		}
		result["messages"] = messages
	}

	if rawTools, ok := body["tools"].([]any); ok {
		tools := []any{}
		for _, raw := range rawTools {
			tool, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if decls, ok := tool["functionDeclarations"].([]any); ok {
				for _, rawDecl := range decls {
					decl, ok := rawDecl.(map[string]any)
					if !ok {
						continue
					}
					tools = append(tools, map[string]any{
						"type": "function",
						"function": map[string]any{
							"name":        decl["name"],
							"description": stringValue(decl["description"]),
							"parameters":  valueOrDefaultMap(decl["parameters"]),
						},
					})
				}
			}
		}
		if len(tools) > 0 {
			result["tools"] = tools
		}
	}

	return result, nil
}

func stripContentTypes(body map[string]any, stripList []string) {
	if len(stripList) == 0 {
		return
	}
	messages, ok := body["messages"].([]any)
	if !ok {
		return
	}
	stripImage := contains(stripList, "image")
	stripAudio := contains(stripList, "audio")
	filteredMessages := make([]any, 0, len(messages))
	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			filteredMessages = append(filteredMessages, raw)
			continue
		}
		parts, ok := msg["content"].([]any)
		if !ok {
			filteredMessages = append(filteredMessages, raw)
			continue
		}
		filtered := make([]any, 0, len(parts))
		for _, rawPart := range parts {
			part, ok := rawPart.(map[string]any)
			if !ok {
				filtered = append(filtered, rawPart)
				continue
			}
			typ := stringValue(part["type"])
			if stripImage && (typ == "image_url" || typ == "image") {
				continue
			}
			if stripAudio && (typ == "audio_url" || typ == "input_audio") {
				continue
			}
			filtered = append(filtered, part)
		}
		if len(filtered) == 0 {
			continue
		} else {
			msg["content"] = filtered
		}
		filteredMessages = append(filteredMessages, msg)
	}
	body["messages"] = filteredMessages
}

func ensureToolCallIDs(body map[string]any) {
	messages, ok := body["messages"].([]any)
	if !ok {
		return
	}
	for i, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if msg["role"] == "assistant" {
			if toolCalls, ok := msg["tool_calls"].([]any); ok {
				for j, rawCall := range toolCalls {
					toolCall, ok := rawCall.(map[string]any)
					if !ok {
						continue
					}
					originalID := stringValue(toolCall["id"])
					if id := sanitizeToolID(originalID); id != "" {
						toolCall["id"] = id
					} else if originalID != "" {
						// Keep the original ID when sanitization strips every character; regenerating
						// would sever the link between an intentionally assigned tool call ID and
						// any matching tool responses already present in the request.
						toolCall["id"] = originalID
					} else {
						fn, _ := toolCall["function"].(map[string]any)
						toolCall["id"] = generateToolCallID(i, j, stringValue(fn["name"]))
					}
					if toolCall["type"] == nil || stringValue(toolCall["type"]) == "" {
						toolCall["type"] = "function"
					}
					if fn, ok := toolCall["function"].(map[string]any); ok {
						if args, ok := fn["arguments"]; ok {
							switch args.(type) {
							case string:
							default:
								if encoded, err := json.Marshal(args); err == nil {
									fn["arguments"] = string(encoded)
								}
							}
						}
					}
				}
			}
		}
		if msg["role"] == "tool" {
			if id := sanitizeToolID(stringValue(msg["tool_call_id"])); id != "" {
				msg["tool_call_id"] = id
			}
		}
		if parts, ok := msg["content"].([]any); ok {
			for j, rawPart := range parts {
				part, ok := rawPart.(map[string]any)
				if !ok {
					continue
				}
				switch stringValue(part["type"]) {
				case "tool_use":
					originalID := stringValue(part["id"])
					if id := sanitizeToolID(originalID); id != "" {
						part["id"] = id
					} else if originalID != "" {
						part["id"] = originalID
					} else {
						part["id"] = generateToolCallID(i, j, stringValue(part["name"]))
					}
				case "tool_result":
					if id := sanitizeToolID(stringValue(part["tool_use_id"])); id != "" {
						part["tool_use_id"] = id
					} else {
						part["tool_use_id"] = generateToolCallID(i, j, "")
					}
				}
			}
		}
	}
}

func fixMissingToolResponses(body map[string]any) {
	messages, ok := body["messages"].([]any)
	if !ok {
		return
	}
	newMessages := make([]any, 0, len(messages))
	for i := 0; i < len(messages); i++ {
		msg, _ := messages[i].(map[string]any)
		newMessages = append(newMessages, messages[i])
		toolCallIDs := getToolCallIDs(msg)
		if len(toolCallIDs) == 0 {
			continue
		}
		if i+1 < len(messages) {
			nextMsg, _ := messages[i+1].(map[string]any)
			if hasToolResults(nextMsg, toolCallIDs) {
				continue
			}
		}
		for _, id := range toolCallIDs {
			newMessages = append(newMessages, map[string]any{
				"role":         "tool",
				"tool_call_id": id,
				"content":      "",
			})
		}
	}
	body["messages"] = newMessages
}

func getToolCallIDs(msg map[string]any) []string {
	if msg == nil || stringValue(msg["role"]) != "assistant" {
		return nil
	}
	ids := []string{}
	if toolCalls, ok := msg["tool_calls"].([]any); ok {
		for _, raw := range toolCalls {
			toolCall, ok := raw.(map[string]any)
			if ok && stringValue(toolCall["id"]) != "" {
				ids = append(ids, stringValue(toolCall["id"]))
			}
		}
	}
	if parts, ok := msg["content"].([]any); ok {
		for _, raw := range parts {
			part, ok := raw.(map[string]any)
			if ok && stringValue(part["type"]) == "tool_use" && stringValue(part["id"]) != "" {
				ids = append(ids, stringValue(part["id"]))
			}
		}
	}
	return ids
}

func hasToolResults(msg map[string]any, toolCallIDs []string) bool {
	if msg == nil || len(toolCallIDs) == 0 {
		return false
	}
	if stringValue(msg["role"]) == "tool" {
		return contains(toolCallIDs, stringValue(msg["tool_call_id"]))
	}
	if stringValue(msg["role"]) == "user" {
		if parts, ok := msg["content"].([]any); ok {
			for _, raw := range parts {
				part, ok := raw.(map[string]any)
				if ok && stringValue(part["type"]) == "tool_result" && contains(toolCallIDs, stringValue(part["tool_use_id"])) {
					return true
				}
			}
		}
	}
	return false
}

func filterToOpenAIFormat(body map[string]any) map[string]any {
	messages, ok := body["messages"].([]any)
	if !ok {
		return body
	}
	filteredMessages := make([]any, 0, len(messages))
	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			filteredMessages = append(filteredMessages, raw)
			continue
		}
		if stringValue(msg["role"]) == "tool" || (stringValue(msg["role"]) == "assistant" && msg["tool_calls"] != nil) {
			filteredMessages = append(filteredMessages, msg)
			continue
		}
		if _, ok := msg["content"].(string); ok {
			if strings.TrimSpace(stringValue(msg["content"])) != "" {
				filteredMessages = append(filteredMessages, msg)
			}
			continue
		}
		parts, ok := msg["content"].([]any)
		if !ok {
			filteredMessages = append(filteredMessages, msg)
			continue
		}
		cleaned := []any{}
		for _, rawPart := range parts {
			part, ok := rawPart.(map[string]any)
			if !ok {
				continue
			}
			typ := stringValue(part["type"])
			if typ == "thinking" || typ == "redacted_thinking" || typ == "tool_use" {
				continue
			}
			if typ == "text" || typ == "image_url" || typ == "image" || typ == "tool_result" {
				clean := map[string]any{}
				for k, v := range part {
					if k == "signature" || k == "cache_control" {
						continue
					}
					clean[k] = v
				}
				cleaned = append(cleaned, clean)
			}
		}
		if len(cleaned) == 0 {
			continue
		}
		if allText(cleaned) {
			texts := make([]string, 0, len(cleaned))
			for _, rawPart := range cleaned {
				part, ok := rawPart.(map[string]any)
				if !ok {
					continue
				}
				texts = append(texts, stringValue(part["text"]))
			}
			msg["content"] = strings.Join(texts, "\n")
		} else {
			msg["content"] = cleaned
		}
		filteredMessages = append(filteredMessages, msg)
	}
	body["messages"] = filteredMessages
	if tools, ok := body["tools"].([]any); ok && len(tools) == 0 {
		delete(body, "tools")
	}
	if rawTools, ok := body["tools"].([]any); ok && len(rawTools) > 0 {
		normalized := []any{}
		for _, raw := range rawTools {
			tool, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if stringValue(tool["type"]) == "function" && tool["function"] != nil {
				normalized = append(normalized, tool)
				continue
			}
			if stringValue(tool["name"]) != "" {
				normalized = append(normalized, map[string]any{"type": "function", "function": map[string]any{"name": tool["name"], "description": stringValue(tool["description"]), "parameters": valueOrDefaultMap(tool["input_schema"])}})
				continue
			}
			if decls, ok := tool["functionDeclarations"].([]any); ok {
				for _, rawDecl := range decls {
					decl, ok := rawDecl.(map[string]any)
					if !ok {
						continue
					}
					normalized = append(normalized, map[string]any{"type": "function", "function": map[string]any{"name": decl["name"], "description": stringValue(decl["description"]), "parameters": valueOrDefaultMap(decl["parameters"])}})
				}
			}
		}
		body["tools"] = normalized
	}
	if choice, ok := body["tool_choice"].(map[string]any); ok {
		switch stringValue(choice["type"]) {
		case "auto":
			body["tool_choice"] = "auto"
		case "any":
			body["tool_choice"] = "required"
		case "tool":
			body["tool_choice"] = map[string]any{"type": "function", "function": map[string]any{"name": choice["name"]}}
		}
	}
	return body
}

func convertClaudeMessage(msg map[string]any) any {
	role := "assistant"
	if stringValue(msg["role"]) == "user" || stringValue(msg["role"]) == "tool" {
		role = "user"
	}
	if content, ok := msg["content"].(string); ok {
		return map[string]any{"role": role, "content": content}
	}
	parts, ok := msg["content"].([]any)
	if !ok {
		return nil
	}
	openAIParts := []any{}
	toolCalls := []any{}
	toolResults := []any{}
	for _, raw := range parts {
		block, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch stringValue(block["type"]) {
		case "text":
			openAIParts = append(openAIParts, map[string]any{"type": "text", "text": stringValue(block["text"])})
		case "image":
			if source, ok := block["source"].(map[string]any); ok && stringValue(source["type"]) == "base64" {
				openAIParts = append(openAIParts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": fmt.Sprintf("data:%s;base64,%s", stringValue(source["media_type"]), stringValue(source["data"]))}})
			}
		case "tool_use":
			args, _ := json.Marshal(block["input"])
			toolCalls = append(toolCalls, map[string]any{"id": block["id"], "type": "function", "function": map[string]any{"name": block["name"], "arguments": string(args)}})
		case "tool_result":
			toolResults = append(toolResults, map[string]any{"role": "tool", "tool_call_id": block["tool_use_id"], "content": stringifyToolResult(block["content"])})
		}
	}
	if len(toolResults) > 0 {
		if len(openAIParts) > 0 {
			return append(toolResults, map[string]any{"role": "user", "content": collapseOpenAIContent(openAIParts)})
		}
		return toolResults
	}
	if len(toolCalls) > 0 {
		result := map[string]any{"role": "assistant", "tool_calls": toolCalls}
		if len(openAIParts) > 0 {
			result["content"] = collapseOpenAIContent(openAIParts)
		}
		return result
	}
	if len(openAIParts) == 0 {
		return map[string]any{"role": role, "content": ""}
	}
	return map[string]any{"role": role, "content": collapseOpenAIContent(openAIParts)}
}

func convertGeminiContent(content map[string]any) map[string]any {
	partsRaw, ok := content["parts"].([]any)
	if !ok {
		return nil
	}
	role := "assistant"
	if stringValue(content["role"]) == "user" {
		role = "user"
	}
	parts := []any{}
	toolCalls := []any{}
	for _, raw := range partsRaw {
		part, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if text, ok := part["text"]; ok {
			parts = append(parts, map[string]any{"type": "text", "text": text})
		}
		if inlineData, ok := part["inlineData"].(map[string]any); ok {
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": fmt.Sprintf("data:%s;base64,%s", stringValue(inlineData["mimeType"]), stringValue(inlineData["data"]))}})
		}
		if functionCall, ok := part["functionCall"].(map[string]any); ok {
			args, _ := json.Marshal(functionCall["args"])
			toolCalls = append(toolCalls, map[string]any{"id": valueOrDefault(stringValue(functionCall["id"]), fmt.Sprintf("call_%d", time.Now().UnixNano())), "type": "function", "function": map[string]any{"name": functionCall["name"], "arguments": string(args)}})
		}
		if functionResponse, ok := part["functionResponse"].(map[string]any); ok {
			payload := functionResponse["response"]
			if respMap, ok := payload.(map[string]any); ok {
				payload = valueOrDefaultAny(respMap["result"], respMap)
			}
			return map[string]any{"role": "tool", "tool_call_id": valueOrDefault(stringValue(functionResponse["id"]), stringValue(functionResponse["name"])), "content": stringifyJSON(payload)}
		}
	}
	if len(toolCalls) > 0 {
		msg := map[string]any{"role": "assistant", "tool_calls": toolCalls}
		if len(parts) > 0 {
			msg["content"] = collapseOpenAIContent(parts)
		}
		return msg
	}
	if len(parts) == 0 {
		return nil
	}
	return map[string]any{"role": role, "content": collapseOpenAIContent(parts)}
}

func extractClaudeSystemText(system any) string {
	switch v := system.(type) {
	case string:
		return v
	case []any:
		parts := []string{}
		for _, raw := range v {
			part, ok := raw.(map[string]any)
			if ok {
				parts = append(parts, stringValue(part["text"]))
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

func extractGeminiText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	if m, ok := content.(map[string]any); ok {
		if parts, ok := m["parts"].([]any); ok {
			texts := []string{}
			for _, raw := range parts {
				part, ok := raw.(map[string]any)
				if ok {
					texts = append(texts, stringValue(part["text"]))
				}
			}
			return strings.Join(texts, "")
		}
	}
	return ""
}

func convertClaudeToolChoice(choice any) any {
	if str, ok := choice.(string); ok {
		return str
	}
	choiceMap, ok := choice.(map[string]any)
	if !ok {
		return "auto"
	}
	switch stringValue(choiceMap["type"]) {
	case "auto":
		return "auto"
	case "any":
		return "required"
	case "tool":
		return map[string]any{"type": "function", "function": map[string]any{"name": choiceMap["name"]}}
	default:
		return "auto"
	}
}

func cloneMap(input map[string]any) (map[string]any, error) {
	if input == nil {
		return map[string]any{}, nil
	}
	if len(input) < 10 {
		out := make(map[string]any, len(input))
		for k, v := range input {
			out[k] = v
		}
		buf, err := json.Marshal(out)
		if err != nil {
			return nil, fmt.Errorf("marshal request body: %w", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(buf, &decoded); err != nil {
			return nil, fmt.Errorf("unmarshal request body: %w", err)
		}
		return decoded, nil
	}
	buf, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("marshal request body: %w", err)
	}
	var out map[string]any
	if err := json.Unmarshal(buf, &out); err != nil {
		return nil, fmt.Errorf("unmarshal request body: %w", err)
	}
	return out, nil
}

func sanitizeToolID(id string) string {
	if id == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func generateToolCallID(msgIndex, tcIndex int, toolName string) string {
	var cleanName strings.Builder
	for _, r := range toolName {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			cleanName.WriteRune(r)
		}
	}
	suffix := fmt.Sprintf("%d_%06d", time.Now().UnixNano(), rand.Intn(1000000))
	if cleanName.Len() > 0 {
		return fmt.Sprintf("call_msg%d_tc%d_%s_%s", msgIndex, tcIndex, cleanName.String(), suffix)
	}
	return fmt.Sprintf("call_msg%d_tc%d_%s", msgIndex, tcIndex, suffix)
}

func validateMessages(body map[string]any) error {
	messages, exists := body["messages"]
	if !exists {
		return nil
	}
	rawMessages, ok := messages.([]any)
	if !ok {
		return nil
	}
	if len(rawMessages) == 0 {
		return fmt.Errorf("messages array must not be empty")
	}
	return nil
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func allText(parts []any) bool {
	for _, raw := range parts {
		part, ok := raw.(map[string]any)
		if !ok || stringValue(part["type"]) != "text" {
			return false
		}
	}
	return true
}

func collapseOpenAIContent(parts []any) any {
	if allText(parts) {
		texts := make([]string, 0, len(parts))
		for _, raw := range parts {
			part, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			texts = append(texts, stringValue(part["text"]))
		}
		return strings.Join(texts, "\n")
	}
	return parts
}

func stringifyToolResult(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		return stringifyJSON(v)
	case float32:
		return stringifyJSON(v)
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return stringifyJSON(v)
	case map[string]any:
		return stringifyJSON(v)
	case []any:
		texts := []string{}
		for _, raw := range v {
			part, ok := raw.(map[string]any)
			if ok && stringValue(part["type"]) == "text" {
				texts = append(texts, stringValue(part["text"]))
			}
		}
		if len(texts) > 0 {
			return strings.Join(texts, "\n")
		}
	}
	return stringifyJSON(value)
}

func stringifyJSON(value any) string {
	buf, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(buf)
}

func valueOrDefaultAny(value any, fallback any) any {
	if value == nil {
		return fallback
	}
	return value
}
