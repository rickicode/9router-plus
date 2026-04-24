package resolve

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type staticClient struct{}

func (staticClient) Resolve(_ context.Context, _ ResolveRequest) (Response, error) {
	return Response{Provider: "openai", Model: "gpt-4.1", ChosenConnectionID: "conn-1"}, nil
}

var _ Client = staticClient{}

func TestHTTPClientResolveParsesContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/proxy/resolve" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if got := r.Header.Get("x-internal-auth"); got != "internal-token" {
			t.Fatalf("expected internal auth header, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"resolution":{"provider":"openai","model":"gpt-4.1","chosenConnection":{"connectionId":"conn-a"},"fallbackChain":[{"connectionId":"conn-b"}]}}`))
	}))
	defer server.Close()

	client := HTTPClient{BaseURL: server.URL, InternalAuth: "internal-token", HTTPClient: server.Client()}

	resp, err := client.Resolve(context.Background(), ResolveRequest{
		Provider:       "openai",
		Model:          "gpt-4.1",
		ProtocolFamily: "openai",
		PublicPath:     "/v1/chat/completions",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if resp.ChosenConnectionID != "conn-a" {
		t.Fatalf("expected chosen connection conn-a, got %q", resp.ChosenConnectionID)
	}
	if len(resp.FallbackConnectionIDs) != 1 || resp.FallbackConnectionIDs[0] != "conn-b" {
		t.Fatalf("unexpected fallback chain: %#v", resp.FallbackConnectionIDs)
	}
}

func TestHTTPClientResolveRejectsBadStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer server.Close()

	client := HTTPClient{BaseURL: server.URL, HTTPClient: server.Client()}
	_, err := client.Resolve(context.Background(), ResolveRequest{
		Provider:       "openai",
		Model:          "gpt-4.1",
		ProtocolFamily: "openai",
		PublicPath:     "/v1/chat/completions",
	})
	if err == nil {
		t.Fatalf("expected error for non-2xx resolve status")
	}
}

func TestHTTPClientResolveRequiresFields(t *testing.T) {
	client := HTTPClient{BaseURL: "http://127.0.0.1:1"}
	_, err := client.Resolve(context.Background(), ResolveRequest{})
	if err == nil {
		t.Fatalf("expected validation error")
	}
}
