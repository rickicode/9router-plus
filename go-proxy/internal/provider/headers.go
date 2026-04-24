package provider

import (
	"net/http"
	"strings"
)

const copilotIntegrationID = "vscode-chat"

func BuildHeaders(provider string, stream bool, options BuildOptions) http.Header {
	headers := make(http.Header)
	headers.Set("Content-Type", "application/json")

	mergeHeaders(headers, options.RegistryHeaders)

	if stream {
		headers.Set("Accept", "text/event-stream")
	}

	switch {
	case provider == "vertex" || provider == "vertex-partner":
		return addProviderHeaders(provider, headers, options)
	case isAnthropicCompatible(provider) || GetTargetFormat(provider) == FormatClaude:
		if key := strings.TrimSpace(options.Credential.APIKey); key != "" {
			headers.Set("x-api-key", key)
		} else if token := strings.TrimSpace(options.Credential.AccessToken); token != "" {
			headers.Set("Authorization", "Bearer "+token)
		}
		headers.Set("anthropic-version", "2023-06-01")
	case provider == "gemini" || provider == "gemini-cli" || provider == "antigravity":
		if key := strings.TrimSpace(options.Credential.APIKey); key != "" {
			headers.Set("x-goog-api-key", key)
		}
	case provider == "github":
		token := strings.TrimSpace(options.CopilotToken)
		if token == "" {
			token = strings.TrimSpace(options.Credential.APIKey)
		}
		if token == "" {
			token = strings.TrimSpace(options.Credential.AccessToken)
		}
		if token != "" {
			headers.Set("Authorization", "Bearer "+token)
		}
		headers.Set("copilot-integration-id", copilotIntegrationID)
		if requestID := strings.TrimSpace(options.RequestID); requestID != "" {
			headers.Set("x-request-id", requestID)
		}
	default:
		token := strings.TrimSpace(options.Credential.APIKey)
		if token == "" {
			token = strings.TrimSpace(options.Credential.AccessToken)
		}
		if token != "" {
			headers.Set("Authorization", "Bearer "+token)
		}
	}

	return addProviderHeaders(provider, headers, options)
}

func mergeHeaders(dst, src http.Header) {
	for key, values := range src {
		copied := append([]string(nil), values...)
		dst[key] = copied
	}
}

func addProviderHeaders(provider string, headers http.Header, _ BuildOptions) http.Header {
	if provider == "cline" {
		headers.Set("HTTP-Referer", "https://cline.bot")
		headers.Set("X-Title", "Cline")
	}
	return headers
}
