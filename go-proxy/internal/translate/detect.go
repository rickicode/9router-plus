package translate

var openAISpecificFields = []string{
	"stream_options",
	"response_format",
	"logprobs",
	"n",
	"presence_penalty",
	"frequency_penalty",
	"logit_bias",
	"user",
}

// DetectFormat identifies the incoming provider request format.
func DetectFormat(body map[string]any) string {
	if body == nil {
		return FormatOpenAI
	}

	if hasOpenAIResponsesInput(body) {
		return FormatOpenAIResponses
	}

	if isAntigravity(body) {
		return FormatAntigravity
	}

	if isGemini(body) {
		return FormatGemini
	}

	if isClaude(body) {
		return FormatClaude
	}

	for _, field := range openAISpecificFields {
		if _, ok := body[field]; ok {
			return FormatOpenAI
		}
	}

	return FormatOpenAI
}

func hasOpenAIResponsesInput(body map[string]any) bool {
	input, ok := body["input"]
	if !ok {
		return false
	}

	switch input.(type) {
	case string, []any:
		return true
	default:
		return false
	}
}

func isAntigravity(body map[string]any) bool {
	if body["userAgent"] != "antigravity" {
		return false
	}

	request, ok := body["request"].(map[string]any)
	if !ok {
		return false
	}

	_, ok = request["contents"].([]any)
	return ok
}

func isGemini(body map[string]any) bool {
	_, ok := body["contents"].([]any)
	return ok
}

func isClaude(body map[string]any) bool {
	if _, ok := body["system"]; ok {
		return true
	}

	if _, ok := body["anthropic_version"]; ok {
		return true
	}

	messages, ok := body["messages"].([]any)
	if !ok {
		return false
	}

	for _, message := range messages {
		messageMap, ok := message.(map[string]any)
		if !ok {
			continue
		}

		content, ok := messageMap["content"].([]any)
		if !ok {
			continue
		}

		for _, block := range content {
			blockMap, ok := block.(map[string]any)
			if !ok {
				continue
			}
			if _, ok := blockMap["type"]; ok {
				return true
			}
		}
	}

	return false
}
