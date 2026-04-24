package provider

import (
	"net/http"
	"strings"
	"testing"

	"go-proxy/internal/credentials"
)

func TestBuildHeaders_OpenAICompatibleUsesBearerAndStreamAccept(t *testing.T) {
	headers := BuildHeaders("openai-compatible-local", true, BuildOptions{
		RegistryHeaders: http.Header{
			"X-Registry":     []string{"registry"},
			"Authorization":  []string{"Bearer registry-token"},
			"Content-Type":   []string{"application/custom"},
		},
		Credential: credentials.Credential{APIKey: "sk-live"},
	})

	if got := headers.Get("Content-Type"); got != "application/custom" {
		t.Fatalf("expected registry content type to win, got %q", got)
	}
	if got := headers.Get("Accept"); got != "text/event-stream" {
		t.Fatalf("expected stream accept header, got %q", got)
	}
	if got := headers.Get("Authorization"); got != "Bearer sk-live" {
		t.Fatalf("expected bearer auth from credential, got %q", got)
	}
	if got := headers.Get("X-Registry"); got != "registry" {
		t.Fatalf("expected registry header to be preserved, got %q", got)
	}
}

func TestBuildHeaders_AnthropicCompatiblePrefersAPIKeyAndAddsVersion(t *testing.T) {
	headers := BuildHeaders("anthropic-compatible-local", false, BuildOptions{
		RegistryHeaders: http.Header{"Authorization": []string{"Bearer registry-token"}},
		Credential: credentials.Credential{APIKey: "sk-anthropic", AccessToken: "token-ignored"},
	})

	if got := headers.Get("x-api-key"); got != "sk-anthropic" {
		t.Fatalf("expected x-api-key auth, got %q", got)
	}
	if got := headers.Get("Authorization"); got != "Bearer registry-token" {
		t.Fatalf("expected registry authorization to remain when api key is preferred, got %q", got)
	}
	if got := headers.Get("anthropic-version"); got != "2023-06-01" {
		t.Fatalf("expected anthropic version header, got %q", got)
	}
}

func TestBuildHeaders_GeminiUsesGoogAPIKey(t *testing.T) {
	headers := BuildHeaders("gemini", false, BuildOptions{
		Credential: credentials.Credential{APIKey: "gem-key"},
	})

	if got := headers.Get("x-goog-api-key"); got != "gem-key" {
		t.Fatalf("expected x-goog-api-key, got %q", got)
	}
	if got := headers.Get("Authorization"); got != "" {
		t.Fatalf("expected no authorization header, got %q", got)
	}
}

func TestBuildHeaders_GitHubUsesCopilotTokenAndAddsMetadata(t *testing.T) {
	headers := BuildHeaders("github", false, BuildOptions{
		Credential:   credentials.Credential{APIKey: "api-fallback", AccessToken: "access-fallback"},
		CopilotToken: "copilot-token",
		RequestID:    "req-123",
	})

	if got := headers.Get("Authorization"); got != "Bearer copilot-token" {
		t.Fatalf("expected copilot token bearer auth, got %q", got)
	}
	if got := headers.Get("copilot-integration-id"); got == "" {
		t.Fatal("expected copilot integration id to be set")
	}
	if got := headers.Get("x-request-id"); got != "req-123" {
		t.Fatalf("expected x-request-id, got %q", got)
	}
}

func TestBuildHeaders_VertexProvidersSkipAuthMutation(t *testing.T) {
	providers := []string{"vertex", "vertex-partner"}
	for _, provider := range providers {
		headers := BuildHeaders(provider, false, BuildOptions{
			RegistryHeaders: http.Header{"Authorization": []string{"Bearer registry-token"}},
			Credential:      credentials.Credential{APIKey: "api-key", AccessToken: "access-token"},
			CopilotToken:    "copilot-token",
		})

		if got := headers.Get("Authorization"); got != "Bearer registry-token" {
			t.Fatalf("provider %q: expected auth to remain unchanged, got %q", provider, got)
		}
		if got := headers.Get("x-api-key"); got != "" {
			t.Fatalf("provider %q: expected no x-api-key mutation, got %q", provider, got)
		}
		if got := headers.Get("x-goog-api-key"); got != "" {
			t.Fatalf("provider %q: expected no x-goog-api-key mutation, got %q", provider, got)
		}
	}
}

func TestBuildHeaders_ClineAddsCustomHeaders(t *testing.T) {
	headers := BuildHeaders("cline", false, BuildOptions{
		Credential: credentials.Credential{APIKey: "sk-cline"},
	})

	if got := headers.Get("Authorization"); got != "Bearer sk-cline" {
		t.Fatalf("expected bearer auth, got %q", got)
	}
	if got := headers.Get("HTTP-Referer"); got != "https://cline.bot" {
		t.Fatalf("expected cline referer header, got %q", got)
	}
	if got := headers.Get("X-Title"); !strings.Contains(strings.ToLower(got), "cline") {
		t.Fatalf("expected cline title header, got %q", got)
	}
}
