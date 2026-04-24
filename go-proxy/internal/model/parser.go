// Package model parses provider-qualified model identifiers and aliases.
package model

import "strings"

// ParsedModel represents a parsed model string and any resolved provider alias.
type ParsedModel struct {
	// Provider is the resolved provider ID when the input includes one.
	Provider string
	// Model is the model name portion of the parsed input.
	Model string
	// IsAlias reports whether the full input should be treated as a model alias.
	IsAlias bool
	// ProviderAlias is the original provider prefix before alias resolution.
	ProviderAlias string
}

var providerAliases = map[string]string{
	"cc":             "claude",
	"cx":             "codex",
	"gc":             "gemini-cli",
	"if":             "iflow",
	"kr":             "kiro",
	"cu":             "cursor",
	"kc":             "kilocode",
	"kmc":            "kimi-coding",
	"oc":             "opencode",
	"ocg":            "opencode-go",
	"el":             "elevenlabs",
	"qw":             "qwen",
	"ag":             "antigravity",
	"gh":             "github",
	"cl":             "cline",
	"minimax-cn":     "minimax-cn",
	"ds":             "deepseek",
	"xai":            "xai",
	"pplx":           "perplexity",
	"cerebras":       "cerebras",
	"hyp":            "hyperbolic",
	"hyperbolic":     "hyperbolic",
	"dg":             "deepgram",
	"deepgram":       "deepgram",
	"aai":            "assemblyai",
	"assemblyai":     "assemblyai",
	"nb":             "nanobanana",
	"nanobanana":     "nanobanana",
	"ch":             "chutes",
	"chutes":         "chutes",
	"cursor":         "cursor",
	"openai":         "openai",
	"anthropic":      "anthropic",
	"gemini":         "gemini",
	"openrouter":     "openrouter",
	"glm":            "glm",
	"kimi":           "kimi",
	"minimax":        "minimax",
	"deepseek":       "deepseek",
	"groq":           "groq",
	"mistral":        "mistral",
	"perplexity":     "perplexity",
	"together":       "together",
	"fireworks":      "fireworks",
	"cohere":         "cohere",
	"nvidia":         "nvidia",
	"nebius":         "nebius",
	"siliconflow":    "siliconflow",
	"vertex":         "vertex",
	"vx":             "vertex",
	"vertex-partner": "vertex-partner",
	"vxp":            "vertex-partner",
	"grok-web":       "grok-web",
	"gw":             "grok-web",
	"perplexity-web": "perplexity-web",
	"pw":             "perplexity-web",
}

// ResolveProviderAlias returns the canonical provider ID for an alias or provider name.
func ResolveProviderAlias(aliasOrID string) string {
	if provider, ok := providerAliases[aliasOrID]; ok {
		return provider
	}

	return aliasOrID
}

// Parse splits a model string into provider and model components when present.
func Parse(modelStr string) ParsedModel {
	if modelStr == "" {
		return ParsedModel{}
	}

	firstSlash := strings.Index(modelStr, "/")
	if firstSlash >= 0 {
		providerOrAlias := modelStr[:firstSlash]
		return ParsedModel{
			Provider:      ResolveProviderAlias(providerOrAlias),
			Model:         modelStr[firstSlash+1:],
			IsAlias:       false,
			ProviderAlias: providerOrAlias,
		}
	}

	return ParsedModel{
		Model:   modelStr,
		IsAlias: true,
	}
}
