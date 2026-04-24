package provider

import "testing"

func TestGetConfig_OpenAICompatibleUsesOpenAIDefaults(t *testing.T) {
	config, ok := GetConfig("openai-compatible-local")
	if !ok {
		t.Fatal("expected compatible provider config")
	}

	if config.BaseURL != "https://api.openai.com/v1" {
		t.Fatalf("expected OpenAI default base URL, got %q", config.BaseURL)
	}
	if config.Format != FormatOpenAI {
		t.Fatalf("expected OpenAI format, got %q", config.Format)
	}
}

func TestGetConfig_OpenAICompatibleResponsesUsesResponsesFormat(t *testing.T) {
	config, ok := GetConfig("openai-compatible-responses-local")
	if !ok {
		t.Fatal("expected compatible responses provider config")
	}

	if config.BaseURL != "https://api.openai.com/v1" {
		t.Fatalf("expected OpenAI default base URL, got %q", config.BaseURL)
	}
	if config.Format != FormatOpenAIResponses {
		t.Fatalf("expected responses format, got %q", config.Format)
	}
}

func TestGetConfig_AnthropicCompatibleUsesClaudeDefaults(t *testing.T) {
	config, ok := GetConfig("anthropic-compatible-local")
	if !ok {
		t.Fatal("expected compatible anthropic provider config")
	}

	if config.BaseURL != "https://api.anthropic.com/v1" {
		t.Fatalf("expected Anthropic default base URL, got %q", config.BaseURL)
	}
	if config.Format != FormatClaude {
		t.Fatalf("expected Claude format, got %q", config.Format)
	}
}

func TestGetConfig_KnownProvidersReturnRegistryEntries(t *testing.T) {
	providers := []string{
		"claude",
		"anthropic",
		"openai",
		"openrouter",
		"gemini",
		"gemini-cli",
		"antigravity",
		"codex",
		"qwen",
		"github",
		"glm",
		"kimi",
		"minimax",
		"cline",
		"vertex",
		"vertex-partner",
		"opencode",
		"opencode-go",
	}

	for _, provider := range providers {
		config, ok := GetConfig(provider)
		if !ok {
			t.Fatalf("expected config for provider %q", provider)
		}
		if config.Name != provider {
			t.Fatalf("provider %q: expected name %q, got %q", provider, provider, config.Name)
		}
	}
}

func TestGetTargetFormat(t *testing.T) {
	tests := []struct {
		provider string
		want     TargetFormat
	}{
		{provider: "openai", want: FormatOpenAI},
		{provider: "openai-compatible-local", want: FormatOpenAI},
		{provider: "openai-compatible-responses-local", want: FormatOpenAIResponses},
		{provider: "anthropic-compatible-local", want: FormatClaude},
		{provider: "claude", want: FormatClaude},
	}

	for _, tt := range tests {
		got := GetTargetFormat(tt.provider)
		if got != tt.want {
			t.Fatalf("provider %q: expected format %q, got %q", tt.provider, tt.want, got)
		}
	}
}
