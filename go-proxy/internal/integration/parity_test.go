package integration

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"go-proxy/internal/credentials"
	"go-proxy/internal/model"
	"go-proxy/internal/provider"
)

func mustLoadStore(t *testing.T) *model.Store {
	t.Helper()

	store, err := model.LoadStore(filepath.Join("..", "testdata", "model", "db_phase1.json"))
	if err != nil {
		t.Fatalf("load store: %v", err)
	}

	return store
}

func TestParity_OpenAICompatibleAliasCustomNodeURLAndHeaders(t *testing.T) {
	store := mustLoadStore(t)

	resolved, err := model.ResolveModel("oaic/fast", store)
	if err != nil {
		t.Fatalf("resolve model: %v", err)
	}

	if resolved.Provider != "openai-compatible-local" {
		t.Fatalf("expected custom openai-compatible node, got %q", resolved.Provider)
	}
	if resolved.Model != "fast" {
		t.Fatalf("expected provider-qualified custom node model to preserve raw model, got %q", resolved.Model)
	}

	aliasResolved, err := model.ResolveModel("fast", store)
	if err != nil {
		t.Fatalf("resolve alias: %v", err)
	}
	if aliasResolved.Provider != "openai" || aliasResolved.Model != "gpt-4.1-mini" {
		t.Fatalf("unexpected alias resolution: %#v", aliasResolved)
	}

	node, ok := store.ProviderNodeByPrefix("oaic", "openai-compatible")
	if !ok {
		t.Fatal("expected openai-compatible provider node")
	}

	cred := credentials.Credential{ConnectionID: "conn-oaic", Provider: resolved.Provider, APIKey: "sk-oaic"}
	options := provider.BuildOptions{
		BaseURL: node.BaseURL,
		RegistryHeaders: http.Header{
			"X-Test": []string{"openai-compatible"},
		},
		Credential: cred,
	}

	gotURL, err := provider.BuildURL(resolved.Provider, aliasResolved.Model, true, options)
	if err != nil {
		t.Fatalf("build url: %v", err)
	}
	if gotURL != "https://oaic.example.com/v1/chat/completions" {
		t.Fatalf("unexpected URL: %q", gotURL)
	}

	headers := provider.BuildHeaders(resolved.Provider, true, options)
	if got := headers.Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected application/json content type, got %q", got)
	}
	if got := headers.Get("Accept"); got != "text/event-stream" {
		t.Fatalf("expected event stream accept header, got %q", got)
	}
	if got := headers.Get("Authorization"); got != "Bearer sk-oaic" {
		t.Fatalf("expected bearer auth, got %q", got)
	}
	if got := headers.Get("X-Test"); got != "openai-compatible" {
		t.Fatalf("expected registry header preserved, got %q", got)
	}
}

func TestParity_AnthropicCompatibleAliasCustomNodeURLAndHeaders(t *testing.T) {
	store := mustLoadStore(t)

	resolved, err := model.ResolveModel("acmp/smart", store)
	if err != nil {
		t.Fatalf("resolve model: %v", err)
	}
	if resolved.Provider != "anthropic-compatible-local" {
		t.Fatalf("expected custom anthropic-compatible node, got %q", resolved.Provider)
	}
	if resolved.Model != "smart" {
		t.Fatalf("expected provider-qualified custom node model to preserve raw model, got %q", resolved.Model)
	}

	aliasResolved, err := model.ResolveModel("smart", store)
	if err != nil {
		t.Fatalf("resolve alias: %v", err)
	}
	if aliasResolved.Provider != "claude" || aliasResolved.Model != "claude-sonnet-4-20250514" {
		t.Fatalf("unexpected alias resolution: %#v", aliasResolved)
	}

	node, ok := store.ProviderNodeByPrefix("acmp", "anthropic-compatible")
	if !ok {
		t.Fatal("expected anthropic-compatible provider node")
	}

	options := provider.BuildOptions{
		BaseURL: node.BaseURL,
		RegistryHeaders: http.Header{
			"X-Test": []string{"anthropic-compatible"},
		},
		Credential: credentials.Credential{ConnectionID: "conn-acmp", Provider: resolved.Provider, APIKey: "sk-acmp"},
	}

	gotURL, err := provider.BuildURL(resolved.Provider, aliasResolved.Model, false, options)
	if err != nil {
		t.Fatalf("build url: %v", err)
	}
	if gotURL != "https://anthropic-proxy.example.com/v1/messages" {
		t.Fatalf("unexpected URL: %q", gotURL)
	}

	headers := provider.BuildHeaders(resolved.Provider, false, options)
	if got := headers.Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected application/json content type, got %q", got)
	}
	if got := headers.Get("x-api-key"); got != "sk-acmp" {
		t.Fatalf("expected x-api-key auth, got %q", got)
	}
	if got := headers.Get("anthropic-version"); got != "2023-06-01" {
		t.Fatalf("expected anthropic version header, got %q", got)
	}
	if got := headers.Get("X-Test"); got != "anthropic-compatible" {
		t.Fatalf("expected registry header preserved, got %q", got)
	}
}

func TestParity_GeminiCustomNodeURLAndHeaders(t *testing.T) {
	resolved := model.Resolution{Provider: "gemini", Model: "gemini-2.5-pro"}
	cred := credentials.Credential{ConnectionID: "conn-gemini", Provider: "gemini", APIKey: "gem-key"}
	options := provider.BuildOptions{Credential: cred}

	gotURL, err := provider.BuildURL(resolved.Provider, resolved.Model, true, options)
	if err != nil {
		t.Fatalf("build url: %v", err)
	}
	if gotURL != "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse" {
		t.Fatalf("unexpected URL: %q", gotURL)
	}

	headers := provider.BuildHeaders(resolved.Provider, true, options)
	if got := headers.Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected application/json content type, got %q", got)
	}
	if got := headers.Get("Accept"); got != "text/event-stream" {
		t.Fatalf("expected event stream accept header, got %q", got)
	}
	if got := headers.Get("x-goog-api-key"); got != "gem-key" {
		t.Fatalf("expected x-goog-api-key auth, got %q", got)
	}
	if got := headers.Get("Authorization"); got != "" {
		t.Fatalf("expected no authorization header, got %q", got)
	}
}

func TestParity_GitHubCopilotCustomNodeURLAndHeaders(t *testing.T) {
	resolved := model.Resolution{Provider: "github", Model: "gpt-4.1"}
	options := provider.BuildOptions{
		Credential:   credentials.Credential{ConnectionID: "conn-gh", Provider: "github", APIKey: "api-fallback", AccessToken: "access-fallback"},
		CopilotToken: "copilot-token",
		RequestID:    "req-gh-123",
	}

	gotURL, err := provider.BuildURL(resolved.Provider, resolved.Model, false, options)
	if err != nil {
		t.Fatalf("build url: %v", err)
	}
	if gotURL != "https://api.githubcopilot.com/chat/completions" {
		t.Fatalf("unexpected URL: %q", gotURL)
	}

	headers := provider.BuildHeaders(resolved.Provider, false, options)
	if got := headers.Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected application/json content type, got %q", got)
	}
	if got := headers.Get("Authorization"); got != "Bearer copilot-token" {
		t.Fatalf("expected copilot bearer auth, got %q", got)
	}
	if got := headers.Get("copilot-integration-id"); got == "" {
		t.Fatal("expected copilot integration id header")
	}
	if got := headers.Get("x-request-id"); got != "req-gh-123" {
		t.Fatalf("expected x-request-id header, got %q", got)
	}
}

func TestParity_ErrorCases(t *testing.T) {
	store := mustLoadStore(t)

	t.Run("unknown provider URL build rejection", func(t *testing.T) {
		_, err := provider.BuildURL("unknown-provider", "model-x", false, provider.BuildOptions{})
		if err == nil || !strings.Contains(err.Error(), "unknown provider") {
			t.Fatalf("expected unknown provider error, got %v", err)
		}
	})

	t.Run("combo model rejection", func(t *testing.T) {
		resolved, err := model.ResolveModel("writer-pack", store)
		if err != nil {
			t.Fatalf("resolve combo: %v", err)
		}
		if !resolved.IsCombo {
			t.Fatalf("expected combo resolution, got %#v", resolved)
		}
	})

	t.Run("missing credentials does not emit auth headers", func(t *testing.T) {
		headers := provider.BuildHeaders("openai", false, provider.BuildOptions{})
		if got := headers.Get("Content-Type"); got != "application/json" {
			t.Fatalf("expected default content type, got %q", got)
		}
		if got := headers.Get("Authorization"); got != "" {
			t.Fatalf("expected no auth header when credentials missing, got %q", got)
		}
	})

	t.Run("missing credential lookup returns connection not found", func(t *testing.T) {
		reader := credentials.NewReader(filepath.Join(t.TempDir(), "db.json"))
		if _, err := reader.ReadByConnectionID("missing-conn"); err == nil {
			t.Fatal("expected missing credential lookup error")
		}
	})
}
