package report

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPClientReportOutcomePostsToInternalEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/proxy/report" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("unexpected method %s", r.Method)
		}
		if got := r.Header.Get("x-internal-auth"); got != "internal-token" {
			t.Fatalf("expected internal auth header, got %q", got)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client := HTTPClient{BaseURL: server.URL, InternalAuth: "internal-token", HTTPClient: server.Client()}
	err := client.ReportOutcome(context.Background(), OutcomePayload{RequestID: "req-1", Outcome: "ok"})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestHTTPClientReportOutcomeIncludesUsageAndQuotasEvidence(t *testing.T) {
	var gotPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotPayload)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client := HTTPClient{BaseURL: server.URL, HTTPClient: server.Client()}
	err := client.ReportOutcome(context.Background(), OutcomePayload{
		RequestID: "req-usage",
		Outcome:   "ok",
		Usage: map[string]any{
			"prompt_tokens":     11,
			"completion_tokens": 22,
		},
		Quotas: map[string]any{
			"weekly": map[string]any{"used": 33, "remaining": 67, "total": 100},
		},
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if gotPayload["usage"] == nil {
		t.Fatalf("expected usage payload to be present")
	}
	if gotPayload["quotas"] == nil {
		t.Fatalf("expected quotas payload to be present")
	}
}

func TestHTTPClientReportOutcomeReturnsErrorOnFailureStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad", http.StatusInternalServerError)
	}))
	defer server.Close()

	client := HTTPClient{BaseURL: server.URL, HTTPClient: server.Client()}
	err := client.ReportOutcome(context.Background(), OutcomePayload{RequestID: "req-1", Outcome: "error"})
	if err == nil {
		t.Fatalf("expected error for non-2xx report status")
	}
}

func TestNoopClientImplementsClient(t *testing.T) {
	if err := NoopClient.ReportOutcome(context.Background(), OutcomePayload{}); err != nil {
		t.Fatalf("expected noop client to succeed, got %v", err)
	}
}
