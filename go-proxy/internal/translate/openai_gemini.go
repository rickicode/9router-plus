package translate

import (
	"fmt"
	"log"
	"strings"
)

var defaultGeminiSafetySettings = []any{
	map[string]any{"category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF"},
	map[string]any{"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF"},
	map[string]any{"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF"},
	map[string]any{"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF"},
}

// OpenAIToGeminiRequest converts an OpenAI chat completion request body into Gemini generateContent format.
// Gemini function names are sanitized to meet provider constraints; names that start with numbers are prefixed with an underscore.
func OpenAIToGeminiRequest(model string, body map[string]any, stream bool, opts TranslateOptions) (map[string]any, error) {
	_ = stream

	safetySettings := make([]any, 0, len(defaultGeminiSafetySettings))
	if len(opts.SafetySettings) > 0 {
		safetySettings = make([]any, 0, len(opts.SafetySettings))
		for _, setting := range opts.SafetySettings {
			safetySettings = append(safetySettings, setting)
		}
	} else {
		safetySettings = append(safetySettings, defaultGeminiSafetySettings...)
	}

	result := map[string]any{
		"model":            model,
		"contents":         []any{},
		"generationConfig": map[string]any{},
		"safetySettings":   safetySettings,
	}

	generationConfig, ok := result["generationConfig"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("generationConfig is not a map")
	}
	if temperature, ok := body["temperature"]; ok {
		generationConfig["temperature"] = temperature
	}
	if topP, ok := body["top_p"]; ok {
		generationConfig["topP"] = topP
	}
	if topK, ok := body["top_k"]; ok {
		generationConfig["topK"] = topK
	}
	if maxTokens, ok := body["max_tokens"]; ok {
		generationConfig["maxOutputTokens"] = maxTokens
	}

	toolCallIDToName := map[string]string{}
	toolResponses := map[string]any{}
	if rawMessages, ok := body["messages"].([]any); ok {
		for _, raw := range rawMessages {
			msg, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if stringValue(msg["role"]) == "assistant" {
				if toolCalls, ok := msg["tool_calls"].([]any); ok {
					for _, rawToolCall := range toolCalls {
						toolCall, ok := rawToolCall.(map[string]any)
						if !ok || stringValue(toolCall["type"]) != "function" {
							continue
						}
						fn, _ := toolCall["function"].(map[string]any)
						id := stringValue(toolCall["id"])
						name := stringValue(fn["name"])
						if id != "" && name != "" {
							toolCallIDToName[id] = name
						}
					}
				}
			}
			if stringValue(msg["role"]) == "tool" {
				if id := stringValue(msg["tool_call_id"]); id != "" {
					toolResponses[id] = msg["content"]
				}
			}
		}

		contents := []any{}
		systemCount := 0
		systemTexts := make([]string, 0, 2)
		for _, raw := range rawMessages {
			msg, ok := raw.(map[string]any)
			if !ok || stringValue(msg["role"]) != "system" {
				continue
			}
			systemCount++
			if text := extractTextContent(msg["content"]); text != "" {
				systemTexts = append(systemTexts, text)
			}
		}
		if systemCount > 5 {
			log.Printf("translate: received %d system messages; joining them with newlines for Gemini systemInstruction", systemCount)
		}
		joinedSystem := strings.Join(systemTexts, "\n")
		if joinedSystem != "" && systemCount > 0 && len(rawMessages) > 1 {
			result["systemInstruction"] = map[string]any{
				"role":  "user",
				"parts": []any{map[string]any{"text": joinedSystem}},
			}
		}

		for _, raw := range rawMessages {
			msg, ok := raw.(map[string]any)
			if !ok {
				continue
			}

			role := stringValue(msg["role"])
			content := msg["content"]

			switch {
			case role == "system" && len(rawMessages) > 1:
				continue
			case role == "user" || (role == "system" && len(rawMessages) == 1):
				parts := convertOpenAIContentToGeminiParts(content)
				if len(parts) > 0 {
					contents = append(contents, map[string]any{"role": "user", "parts": parts})
				}
			case role == "assistant":
				parts := []any{}
				if reasoning := stringValue(msg["reasoning_content"]); reasoning != "" {
					parts = append(parts, map[string]any{"thought": true, "text": reasoning})
				}
				if text := extractTextContent(content); text != "" {
					parts = append(parts, map[string]any{"text": text})
				}

				toolCallIDs := []string{}
				if toolCalls, ok := msg["tool_calls"].([]any); ok {
					for _, rawToolCall := range toolCalls {
						toolCall, ok := rawToolCall.(map[string]any)
						if !ok || stringValue(toolCall["type"]) != "function" {
							continue
						}
						fn, _ := toolCall["function"].(map[string]any)
						if fn == nil {
							log.Printf("translate: assistant tool call missing function field for Gemini request")
							continue
						}
						id := stringValue(toolCall["id"])
						parts = append(parts, map[string]any{
							"functionCall": map[string]any{
								"id":   id,
								"name": sanitizeGeminiFunctionName(stringValue(fn["name"])),
								"args": tryParseJSON(fn["arguments"]),
							},
						})
						toolCallIDs = append(toolCallIDs, id)
					}
				}

				if len(parts) > 0 {
					contents = append(contents, map[string]any{"role": "model", "parts": parts})
				}

				toolParts := []any{}
				for _, id := range toolCallIDs {
					resp, ok := toolResponses[id]
					if !ok {
						continue
					}
					responseValue := validatedGeminiToolResponse(resp)
					parsed := tryParseJSON(resp)
					if parsed != nil {
						switch value := parsed.(type) {
						case map[string]any:
							if _, hasResult := value["result"]; hasResult {
								responseValue = value
							} else {
								responseValue = map[string]any{"result": value}
							}
						case []any:
							responseValue = map[string]any{"result": value}
						default:
							responseValue = map[string]any{"result": value}
						}
					}
					name := toolCallIDToName[id]
					if name == "" {
						name = id
					}
					toolParts = append(toolParts, map[string]any{
						"functionResponse": map[string]any{
							"id":   id,
							"name": sanitizeGeminiFunctionName(name),
							"response": responseValue,
						},
					})
				}
				if len(toolParts) > 0 {
					contents = append(contents, map[string]any{"role": "user", "parts": toolParts})
				}
			}
		}
		result["contents"] = contents
	}

	if rawTools, ok := body["tools"].([]any); ok && len(rawTools) > 0 {
		functionDeclarations := []any{}
		for _, rawTool := range rawTools {
			tool, ok := rawTool.(map[string]any)
			if !ok {
				continue
			}

			if name := stringValue(tool["name"]); name != "" {
				functionDeclarations = append(functionDeclarations, map[string]any{
					"name":        sanitizeGeminiFunctionName(name),
					"description": stringValue(tool["description"]),
					"parameters":  valueOrDefaultMap(tool["input_schema"]),
				})
				continue
			}

			if stringValue(tool["type"]) != "function" {
				continue
			}
			fn, _ := tool["function"].(map[string]any)
			functionDeclarations = append(functionDeclarations, map[string]any{
				"name":        sanitizeGeminiFunctionName(stringValue(fn["name"])),
				"description": stringValue(fn["description"]),
				"parameters":  valueOrDefaultMap(fn["parameters"]),
			})
		}
		if len(functionDeclarations) > 0 {
			result["tools"] = []any{map[string]any{"functionDeclarations": functionDeclarations}}
		}
	}

	return result, nil
}

func convertOpenAIContentToGeminiParts(content any) []any {
	parts := []any{}
	switch value := content.(type) {
	case string:
		if value != "" {
			parts = append(parts, map[string]any{"text": value})
		}
	case []any:
		for _, rawPart := range value {
			part, ok := rawPart.(map[string]any)
			if !ok {
				continue
			}
			if stringValue(part["type"]) == "text" {
				if text := stringValue(part["text"]); text != "" {
					parts = append(parts, map[string]any{"text": text})
				}
			}
		}
	}
	return parts
}

func sanitizeGeminiFunctionName(name string) string {
	if name == "" {
		return "_unknown"
	}
	var builder strings.Builder
	for i, r := range name {
		allowed := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == ':' || r == '-'
		if !allowed {
			r = '_'
		}
		if i == 0 && !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_') {
			if builder.Len() < 64 {
				builder.WriteByte('_')
			}
		}
		if r == '-' {
			r = '_'
		}
		if builder.Len()+len(string(r)) > 64 {
			break
		}
		builder.WriteRune(r)
		if builder.Len() >= 64 {
			break
		}
	}
	sanitized := builder.String()
	if sanitized == "" {
		return "_unknown"
	}
	if len(sanitized) > 64 {
		return sanitized[:64]
	}
	return sanitized
}

func validatedGeminiToolResponse(resp any) any {
	switch value := resp.(type) {
	case nil:
		return map[string]any{"result": ""}
	case string:
		parsed := tryParseJSON(value)
		if parsed == nil {
			return map[string]any{"result": value}
		}
		switch parsedValue := parsed.(type) {
		case map[string]any:
			if _, hasResult := parsedValue["result"]; hasResult {
				return parsedValue
			}
			return map[string]any{"result": parsedValue}
		case []any, bool, float64:
			return map[string]any{"result": parsedValue}
		default:
			return map[string]any{"result": parsedValue}
		}
	case map[string]any:
		if _, hasResult := value["result"]; hasResult {
			return value
		}
		return map[string]any{"result": value}
	case []any, bool, float64, int, int64, int32, uint, uint64, uint32:
		return map[string]any{"result": value}
	default:
		log.Printf("translate: unsupported Gemini tool response content type %T; coercing to string", resp)
		return map[string]any{"result": stringifyToolResult(resp)}
	}
}

func valueOrDefaultMap(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	return map[string]any{"type": "object", "properties": map[string]any{}}
}
