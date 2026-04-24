package provider

import "strings"

type TargetFormat string

const (
	FormatOpenAI          TargetFormat = "openai"
	FormatOpenAIResponses TargetFormat = "openai-responses"
	FormatClaude          TargetFormat = "claude"
	FormatGemini          TargetFormat = "gemini"
	FormatGeminiCLI       TargetFormat = "gemini-cli"
	FormatAntigravity     TargetFormat = "antigravity"
	FormatVertex          TargetFormat = "vertex"
)

const (
	openAICompatiblePrefix   = "openai-compatible-"
	anthropicCompatiblePrefix = "anthropic-compatible-"
	openAICompatibleBaseURL  = "https://api.openai.com/v1"
	anthropicCompatibleBaseURL = "https://api.anthropic.com/v1"
)

type Config struct {
	Name     string
	BaseURL  string
	BaseURLs []string
	Format   TargetFormat
}

var registry = map[string]Config{
	"claude":         {Name: "claude", BaseURL: "https://api.anthropic.com/v1/messages", Format: FormatClaude},
	"anthropic":      {Name: "anthropic", BaseURL: "https://api.anthropic.com/v1/messages", Format: FormatClaude},
	"openai":         {Name: "openai", BaseURL: "https://api.openai.com/v1/chat/completions", Format: FormatOpenAI},
	"openrouter":     {Name: "openrouter", BaseURL: "https://openrouter.ai/api/v1/chat/completions", Format: FormatOpenAI},
	"gemini":         {Name: "gemini", BaseURL: "https://generativelanguage.googleapis.com/v1beta/models", Format: FormatGemini},
	"gemini-cli":     {Name: "gemini-cli", BaseURL: "https://cloudcode-pa.googleapis.com/v1internal", Format: FormatGeminiCLI},
	"antigravity":    {Name: "antigravity", BaseURLs: []string{"https://daily-cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.sandbox.googleapis.com"}, Format: FormatAntigravity},
	"codex":          {Name: "codex", BaseURL: "https://chatgpt.com/backend-api/codex/responses", Format: FormatOpenAIResponses},
	"qwen":           {Name: "qwen", BaseURL: "https://portal.qwen.ai/v1/chat/completions", Format: FormatOpenAI},
	"github":         {Name: "github", BaseURL: "https://api.githubcopilot.com/chat/completions", Format: FormatOpenAI},
	"glm":            {Name: "glm", BaseURL: "https://api.z.ai/api/anthropic/v1/messages", Format: FormatClaude},
	"kimi":           {Name: "kimi", BaseURL: "https://api.kimi.com/coding/v1/messages", Format: FormatClaude},
	"minimax":        {Name: "minimax", BaseURL: "https://api.minimax.io/anthropic/v1/messages", Format: FormatClaude},
	"cline":          {Name: "cline", BaseURL: "https://api.cline.bot/api/v1/chat/completions", Format: FormatOpenAI},
	"vertex":         {Name: "vertex", BaseURL: "https://aiplatform.googleapis.com", Format: FormatVertex},
	"vertex-partner": {Name: "vertex-partner", BaseURL: "https://aiplatform.googleapis.com", Format: FormatOpenAI},
	"opencode":       {Name: "opencode", BaseURL: "https://opencode.ai", Format: FormatOpenAI},
	"opencode-go":    {Name: "opencode-go", BaseURL: "https://opencode.ai/zen/go/v1/chat/completions", Format: FormatOpenAI},
}

func GetConfig(provider string) (Config, bool) {
	if isOpenAICompatible(provider) {
		format := FormatOpenAI
		if getOpenAICompatibleType(provider) == "responses" {
			format = FormatOpenAIResponses
		}
		return Config{Name: provider, BaseURL: openAICompatibleBaseURL, Format: format}, true
	}

	if isAnthropicCompatible(provider) {
		return Config{Name: provider, BaseURL: anthropicCompatibleBaseURL, Format: FormatClaude}, true
	}

	config, ok := registry[provider]
	return config, ok
}

func GetTargetFormat(provider string) TargetFormat {
	config, ok := GetConfig(provider)
	if !ok {
		return FormatOpenAI
	}
	return config.Format
}

func isOpenAICompatible(provider string) bool {
	return strings.HasPrefix(provider, openAICompatiblePrefix)
}

func isAnthropicCompatible(provider string) bool {
	return strings.HasPrefix(provider, anthropicCompatiblePrefix)
}

func getOpenAICompatibleType(provider string) string {
	if strings.Contains(provider, "responses") {
		return "responses"
	}
	return "chat"
}
