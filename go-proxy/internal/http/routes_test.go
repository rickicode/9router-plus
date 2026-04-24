package http

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go-proxy/internal/config"
	"go-proxy/internal/credentials"
	"go-proxy/internal/model"
	"go-proxy/internal/provider"
	"go-proxy/internal/proxy"
	"go-proxy/internal/report"
	"go-proxy/internal/resolve"
	"go-proxy/internal/translate"
)

func TestConfigDefaults(t *testing.T) {
	cfg := config.Default()

	if cfg.Host != "127.0.0.1" {
		t.Fatalf("expected default host 127.0.0.1, got %q", cfg.Host)
	}

	if cfg.Port != 8080 {
		t.Fatalf("expected default port 8080, got %d", cfg.Port)
	}

	if cfg.NineRouterBaseURL != "http://127.0.0.1:20128" {
		t.Fatalf("expected default 9router base URL http://127.0.0.1:20128, got %q", cfg.NineRouterBaseURL)
	}
}

func TestHealthEndpointScaffold(t *testing.T) {
	h := NewRoutes(config.Default())

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}

	var payload map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("expected valid JSON response, got error: %v", err)
	}

	if payload["status"] != "ok" {
		t.Fatalf("expected status field to be ok, got %q", payload["status"])
	}
}

func TestPublicProxyEndpointsAreRegistered(t *testing.T) {
	h := NewRoutes(config.Default())

	paths := []string{"/v1/chat/completions", "/v1/responses", "/v1/messages"}
	for _, path := range paths {
		req := httptest.NewRequest(http.MethodOptions, path, nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405 for %s when wrong method is used, got %d", path, rr.Code)
		}
	}
}

func TestPublicProxyEndpointRequiresAPIKey(t *testing.T) {
	h := NewRoutes(config.Default())

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for missing api key, got %d", rr.Code)
	}
}

func TestBuildUpstreamURLUsesApprovedPublicPaths(t *testing.T) {
	if got := buildUpstreamURL("openai", "/v1/chat/completions"); got != "https://api.openai.com/v1/chat/completions" {
		t.Fatalf("unexpected openai path wiring: %q", got)
	}
	if got := buildUpstreamURL("openai", "/v1/responses"); got != "https://api.openai.com/v1/responses" {
		t.Fatalf("unexpected openai responses path wiring: %q", got)
	}
	if got := buildUpstreamURL("anthropic", "/v1/messages"); got != "https://api.anthropic.com/v1/messages" {
		t.Fatalf("unexpected anthropic path wiring: %q", got)
	}
}

func TestExtractModelAndStream(t *testing.T) {
	model, stream, err := extractModelAndStream([]byte(`{"model":"gpt-4.1","stream":true}`))
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if model != "gpt-4.1" {
		t.Fatalf("expected model gpt-4.1, got %q", model)
	}
	if !stream {
		t.Fatalf("expected stream flag true")
	}
}

func TestExtractModelAndStream_RequiresModel(t *testing.T) {
	_, _, err := extractModelAndStream([]byte(`{"model":"   ","stream":true}`))
	if err == nil {
		t.Fatal("expected error for empty model")
	}
	if err.Error() != "model field is required" {
		t.Fatalf("expected required-model error, got %v", err)
	}
}

func TestReadPublicAPIKeySupportsBearerAndHeader(t *testing.T) {
	bearerReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	bearerReq.Header.Set("Authorization", "Bearer sk-test")
	if key := readPublicAPIKey(bearerReq); key != "sk-test" {
		t.Fatalf("expected bearer api key, got %q", key)
	}

	xKeyReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	xKeyReq.Header.Set("x-api-key", "sk-alt")
	if key := readPublicAPIKey(xKeyReq); key != "sk-alt" {
		t.Fatalf("expected x-api-key, got %q", key)
	}
}

func TestMapForwardError(t *testing.T) {
	mapped := mapForwardError(nil)
	if mapped != nil {
		t.Fatalf("expected nil mapped error")
	}

	mapped = mapForwardError(&proxy.ForwardError{Message: "boom", Phase: "upstream"})
	if mapped == nil || mapped.Message != "boom" || mapped.Phase != "upstream" {
		t.Fatalf("unexpected mapped error: %#v", mapped)
	}
}

func TestNewRoutes_UsesDistinctResolveAndReportTokens(t *testing.T) {
	t.Setenv("INTERNAL_PROXY_RESOLVE_TOKEN", "resolve-token-123")
	t.Setenv("INTERNAL_PROXY_REPORT_TOKEN", "report-token-456")
	t.Setenv("GO_PROXY_HTTP_TIMEOUT_SECONDS", "2")

	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"openai","authType":"apiKey","apiKey":"upstream-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}
	t.Setenv("GO_PROXY_CREDENTIALS_FILE", credPath)

	resolveSeen := make(chan string, 1)
	reportSeen := make(chan string, 1)
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/internal/proxy/resolve":
			resolveSeen <- r.Header.Get("x-internal-auth")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"resolution":{"provider":"openai","model":"gpt-4.1","chosenConnection":{"connectionId":"conn-a"},"fallbackChain":[]}}`))
		case "/api/internal/proxy/report":
			reportSeen <- r.Header.Get("x-internal-auth")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer internal.Close()

	h := NewRoutes(config.Config{
		Host:                     "127.0.0.1",
		Port:                     8080,
		NineRouterBaseURL:        internal.URL,
		InternalResolveAuthToken: "resolve-token-123",
		InternalReportAuthToken:  "report-token-456",
		CredentialsFilePath:      credPath,
		HTTPTimeoutSeconds:       2,
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4.1"}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code == http.StatusOK {
		t.Fatalf("expected non-200 upstream result in this unit test setup")
	}

	select {
	case got := <-resolveSeen:
		if got != "resolve-token-123" {
			t.Fatalf("expected resolve token, got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatalf("resolve endpoint was not called")
	}

	select {
	case got := <-reportSeen:
		if got != "report-token-456" {
			t.Fatalf("expected report token, got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatalf("report endpoint was not called")
	}

}

func TestExtractResponseEvidenceFromNonStreamOpenAIBody(t *testing.T) {
	resp := proxy.ForwardResponse{Body: []byte(`{"id":"resp_1","usage":{"prompt_tokens":12,"completion_tokens":34}}`)}

	usage, quotas := extractResponseEvidence(resp)
	if usage == nil {
		t.Fatalf("expected usage evidence to be extracted")
	}
	if got, ok := usage["prompt_tokens"].(float64); !ok || int(got) != 12 {
		t.Fatalf("expected prompt_tokens=12, got %#v", usage["prompt_tokens"])
	}
	if got, ok := usage["completion_tokens"].(float64); !ok || int(got) != 34 {
		t.Fatalf("expected completion_tokens=34, got %#v", usage["completion_tokens"])
	}
	if quotas != nil {
		t.Fatalf("expected no quotas evidence for plain OpenAI usage payload")
	}
}

func TestExtractResponseEvidenceReadsNestedQuotasFromUsage(t *testing.T) {
	resp := proxy.ForwardResponse{Body: []byte(`{"usage":{"input_tokens":5,"output_tokens":8,"quotas":{"weekly":{"used":13,"remaining":7,"total":20}}}}`)}

	usage, quotas := extractResponseEvidence(resp)
	if usage == nil {
		t.Fatalf("expected usage evidence")
	}
	if quotas == nil {
		t.Fatalf("expected nested quotas evidence")
	}
	weekly, ok := quotas["weekly"].(map[string]any)
	if !ok {
		t.Fatalf("expected weekly quota map, got %#v", quotas["weekly"])
	}
	if got, ok := weekly["remaining"].(float64); !ok || int(got) != 7 {
		t.Fatalf("expected weekly remaining=7, got %#v", weekly["remaining"])
	}
}

func TestExtractResponseEvidenceReturnsNilWhenNoUsageAvailable(t *testing.T) {
	resp := proxy.ForwardResponse{Body: []byte(`{"id":"resp_1","object":"response"}`)}
	usage, quotas := extractResponseEvidence(resp)
	if usage != nil || quotas != nil {
		t.Fatalf("expected nil evidence when usage is absent, got usage=%#v quotas=%#v", usage, quotas)
	}
}

func TestExtractResponseEvidenceReturnsNilForStreamBodyWithoutBufferedPayload(t *testing.T) {
	resp := proxy.ForwardResponse{BodyStream: io.NopCloser(strings.NewReader("data: done\n\n"))}
	usage, quotas := extractResponseEvidence(resp)
	if usage != nil || quotas != nil {
		t.Fatalf("expected nil evidence for streaming-only response, got usage=%#v quotas=%#v", usage, quotas)
	}
}

func TestExtractResponseEvidencePrefersCapturedStreamEvidence(t *testing.T) {
	resp := proxy.ForwardResponse{
		BodyStream:     io.NopCloser(strings.NewReader("data: ignored\n\n")),
		UsageEvidence:  map[string]any{"prompt_tokens": float64(11), "completion_tokens": float64(5)},
		QuotasEvidence: map[string]any{"daily": map[string]any{"remaining": float64(9)}},
	}
	usage, quotas := extractResponseEvidence(resp)
	if usage == nil || quotas == nil {
		t.Fatalf("expected captured stream evidence, got usage=%#v quotas=%#v", usage, quotas)
	}
	if got, ok := usage["prompt_tokens"].(float64); !ok || int(got) != 11 {
		t.Fatalf("expected prompt_tokens=11, got %#v", usage["prompt_tokens"])
	}
}

func TestExtractUsageAndQuotasFromSSE(t *testing.T) {
	payload := strings.Join([]string{
		"event: message",
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}",
		"",
		"event: message",
		"data: {\"type\":\"response.completed\",\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":7,\"quotas\":{\"daily\":{\"remaining\":90}}}}",
		"",
	}, "\n")

	usage, quotas := extractUsageAndQuotasFromSSE([]byte(payload))
	if usage == nil {
		t.Fatalf("expected usage from SSE payload")
	}
	if quotas == nil {
		t.Fatalf("expected quotas from nested usage payload")
	}
	if got, ok := usage["completion_tokens"].(float64); !ok || int(got) != 7 {
		t.Fatalf("expected completion_tokens=7, got %#v", usage["completion_tokens"])
	}
}

func TestHandleProxy_StreamingSuccessReportsUsageEvidenceFromSSE(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"openai","authType":"apiKey","apiKey":"upstream-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	reporter := &capturingReporter{}
	h := requestHandler{
		resolver: staticResolveClient{response: resolve.Response{
			Provider:           "openai",
			Model:              "gpt-4.1",
			ChosenConnectionID: "conn-a",
		}},
		reporter:   reporter,
		credReader: credentialsReaderForTest(credPath),
		httpClient: &http.Client{Transport: staticResponseRoundTripper{resp: &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body: io.NopCloser(strings.NewReader(strings.Join([]string{
				"event: message",
				"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}",
				"",
				"event: message",
				"data: {\"type\":\"response.completed\",\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":6,\"quotas\":{\"daily\":{\"remaining\":10}}}}",
				"",
			}, "\n"))),
		}}},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4.1","stream":true}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()
	h.handleProxy(rr, req, "openai")

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for streamed success, got %d", rr.Code)
	}
	if reporter.calls != 1 {
		t.Fatalf("expected one report call, got %d", reporter.calls)
	}
	if reporter.last.Outcome != string(proxy.OutcomeOK) {
		t.Fatalf("expected ok outcome, got %q", reporter.last.Outcome)
	}
	if reporter.last.Usage == nil {
		t.Fatalf("expected usage evidence in report payload")
	}
	if got, ok := reporter.last.Usage["prompt_tokens"].(float64); !ok || int(got) != 4 {
		t.Fatalf("expected prompt_tokens=4, got %#v", reporter.last.Usage["prompt_tokens"])
	}
	if reporter.last.Quotas == nil {
		t.Fatalf("expected quotas evidence in report payload")
	}
	if reporter.last.RequestID == "" {
		t.Fatal("expected request id to be populated")
	}
}

func TestHandleProxy_RequestIDConsistentOnForwardError(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"openai","authType":"apiKey","apiKey":"bad-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	reporter := &capturingReporter{}
	h := requestHandler{
		resolver: staticResolveClient{response: resolve.Response{
			Provider:           "openai",
			Model:              "gpt-4.1",
			ChosenConnectionID: "conn-a",
		}},
		reporter:   reporter,
		credReader: credentialsReaderForTest(credPath),
		httpClient: &http.Client{Transport: failingRoundTripper{err: errors.New("dial boom")}},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4.1"}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()
	h.handleProxy(rr, req, "openai")

	if reporter.calls != 1 {
		t.Fatalf("expected one report call, got %d", reporter.calls)
	}
	if reporter.last.RequestID == "" {
		t.Fatal("expected request id on error path")
	}
}

func TestHandleProxy_RequestIDConsistentOnSuccess(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"openai","authType":"apiKey","apiKey":"upstream-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	reporter := &capturingReporter{}
	h := requestHandler{
		resolver: staticResolveClient{response: resolve.Response{
			Provider:           "openai",
			Model:              "gpt-4.1",
			ChosenConnectionID: "conn-a",
		}},
		reporter:   reporter,
		credReader: credentialsReaderForTest(credPath),
		httpClient: &http.Client{Transport: staticResponseRoundTripper{resp: &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
		}}},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4.1"}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()
	h.handleProxy(rr, req, "openai")

	if reporter.calls != 1 {
		t.Fatalf("expected one report call, got %d", reporter.calls)
	}
	if reporter.last.RequestID == "" {
		t.Fatal("expected request id on success path")
	}
}

func TestHandleProxy_ReportsUsedFallbackConnectionID(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"openai","authType":"apiKey","apiKey":"bad-key"},{"id":"conn-b","provider":"openai","authType":"apiKey","apiKey":"good-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	var reportedConnectionID string
	var reportedPromptTokens int
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/internal/proxy/resolve":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"resolution":{"provider":"openai","model":"gpt-4.1","chosenConnection":{"connectionId":"conn-a"},"fallbackChain":[{"connectionId":"conn-b"}]}}`))
		case "/api/internal/proxy/report":
			body, _ := io.ReadAll(r.Body)
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			if v, ok := payload["connectionId"].(string); ok {
				reportedConnectionID = v
			}
			if usage, ok := payload["usage"].(map[string]any); ok {
				if prompt, ok := usage["prompt_tokens"].(float64); ok {
					reportedPromptTokens = int(prompt)
				}
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer internal.Close()

	h := NewRoutes(config.Config{
		Host:                     "127.0.0.1",
		Port:                     8080,
		NineRouterBaseURL:        internal.URL,
		InternalResolveAuthToken: "resolve-token",
		InternalReportAuthToken:  "report-token",
		CredentialsFilePath:      credPath,
		HTTPTimeoutSeconds:       2,
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4.1"}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code == http.StatusOK {
		t.Fatalf("expected non-200 upstream result in this unit test setup")
	}
	if reportedConnectionID != "conn-b" {
		t.Fatalf("expected report to use fallback connection conn-b, got %q", reportedConnectionID)
	}
	if reportedPromptTokens != 0 {
		t.Fatalf("expected no usage evidence for failed fallback flow, got prompt_tokens=%d", reportedPromptTokens)
	}
}

func TestHandleProxy_ReportUsesFreshContextWhenRequestCanceled(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"openai","authType":"apiKey","apiKey":"bad-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	reporter := &contextInspectingReporter{}
	h := requestHandler{
		resolver: staticResolveClient{response: resolve.Response{
			Provider:           "openai",
			Model:              "gpt-4.1",
			ChosenConnectionID: "conn-a",
		}},
		reporter:   reporter,
		credReader: credentialsReaderForTest(credPath),
		httpClient: &http.Client{Transport: failingRoundTripper{err: errors.New("dial boom")}},
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4.1"}`)).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()
	h.handleProxy(rr, req, "openai")

	if rr.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when forwarding fails, got %d", rr.Code)
	}
	if reporter.calls != 1 {
		t.Fatalf("expected one report call, got %d", reporter.calls)
	}
	if reporter.lastCtxErr != nil {
		t.Fatalf("expected fresh report context to be active, got %v", reporter.lastCtxErr)
	}
	if !reporter.lastCtxHasDeadline {
		t.Fatalf("expected report context to set a timeout deadline")
	}
}

func TestHandleProxy_ReportsForwardingTransportFailure(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"openai","authType":"apiKey","apiKey":"bad-key"},{"id":"conn-b","provider":"openai","authType":"apiKey","apiKey":"good-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	reporter := &capturingReporter{}
	h := requestHandler{
		resolver: staticResolveClient{response: resolve.Response{
			Provider:              "openai",
			Model:                 "gpt-4.1",
			ChosenConnectionID:    "conn-a",
			FallbackConnectionIDs: []string{"conn-b"},
		}},
		reporter:   reporter,
		credReader: credentialsReaderForTest(credPath),
		httpClient: &http.Client{Transport: failingRoundTripper{err: errors.New("dial boom")}},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4.1"}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()
	h.handleProxy(rr, req, "openai")

	if rr.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when forwarding fails, got %d", rr.Code)
	}
	if reporter.calls != 1 {
		t.Fatalf("expected one report call, got %d", reporter.calls)
	}
	if reporter.last.ConnectionID != "conn-b" {
		t.Fatalf("expected report to use final attempted connection conn-b, got %q", reporter.last.ConnectionID)
	}
	if reporter.last.Outcome != string(proxy.OutcomeError) {
		t.Fatalf("expected error outcome, got %q", reporter.last.Outcome)
	}
	if reporter.last.UpstreamStatus != 0 {
		t.Fatalf("expected upstream status 0 for transport failure, got %d", reporter.last.UpstreamStatus)
	}
	if reporter.last.Error == nil {
		t.Fatalf("expected normalized error payload")
	}
	if reporter.last.Error.Phase != "transport" {
		t.Fatalf("expected transport phase, got %q", reporter.last.Error.Phase)
	}
	if !strings.Contains(reporter.last.Error.Message, "dial boom") {
		t.Fatalf("expected transport error message to include dial boom, got %q", reporter.last.Error.Message)
	}
}

func TestHandleProxy_ResolvesAliasBuildsProviderURLAndHeaders(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{
		"modelAliases":{"fast":"oaic/gpt-4.1-mini"},
		"providerNodes":[{"id":"openai-compatible-local","type":"openai-compatible","prefix":"oaic","baseUrl":"https://custom-openai.example/v1","apiType":"chat"}],
		"providerConnections":[{"id":"conn-a","provider":"openai-compatible-local","authType":"apiKey","apiKey":"upstream-key"}]
	}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	var seenURL string
	var seenAuth string
	var seenAccept string
	var seenContentType string
	h := requestHandler{
		reporter:            &capturingReporter{},
		credReader:          credentialsReaderForTest(credPath),
		credentialsFilePath: credPath,
		modelStore:          mustLoadModelStore(t, credPath),
		httpClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			seenURL = req.URL.String()
			seenAuth = req.Header.Get("Authorization")
			seenAccept = req.Header.Get("Accept")
			seenContentType = req.Header.Get("Content-Type")
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
			}, nil
		})},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions?trace=1", strings.NewReader(`{"model":"fast","stream":true}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	h.handleProxy(rr, req, "openai")

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if seenURL != "https://custom-openai.example/v1/chat/completions?trace=1" {
		t.Fatalf("expected resolved provider URL, got %q", seenURL)
	}
	if seenAuth != "Bearer upstream-key" {
		t.Fatalf("expected upstream auth header, got %q", seenAuth)
	}
	if seenAccept != "text/event-stream" {
		t.Fatalf("expected stream accept header, got %q", seenAccept)
	}
	if seenContentType != "application/json" {
		t.Fatalf("expected content type to be preserved, got %q", seenContentType)
	}
}

func TestHandleProxy_UnknownProviderReturnsBadGateway(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"mystery","authType":"apiKey","apiKey":"upstream-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	h := requestHandler{
		resolver:            staticResolveClient{response: resolve.Response{Provider: "mystery", Model: "mystery-model", ChosenConnectionID: "conn-a"}},
		reporter:            &capturingReporter{},
		credReader:          credentialsReaderForTest(credPath),
		credentialsFilePath: credPath,
		modelStore:          mustLoadModelStore(t, credPath),
		httpClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return nil, errors.New("should not send upstream request")
		})},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"mystery-model"}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()

	h.handleProxy(rr, req, "openai")

	if rr.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 for unknown provider, got %d", rr.Code)
	}
}

func TestHandleProxy_ComboModelReturnsBadRequest(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"combos":[{"name":"writer-pack","models":["openai/gpt-4.1","anthropic/claude-sonnet-4"]}],"providerConnections":[{"id":"conn-a","provider":"openai","authType":"apiKey","apiKey":"upstream-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	h := requestHandler{
		reporter:            &capturingReporter{},
		credReader:          credentialsReaderForTest(credPath),
		credentialsFilePath: credPath,
		modelStore:          mustLoadModelStore(t, credPath),
		httpClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return nil, errors.New("should not send upstream request")
		})},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"writer-pack"}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()

	h.handleProxy(rr, req, "openai")

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for combo model, got %d", rr.Code)
	}
}

func TestCloneForwardHeaders_FiltersUnsafeHeaders(t *testing.T) {
	headers := cloneForwardHeaders(http.Header{
		"Content-Type":      []string{"application/json"},
		"Accept":            []string{"application/json"},
		"Accept-Encoding":   []string{"gzip"},
		"User-Agent":        []string{"test-agent"},
		"Authorization":     []string{"Bearer secret"},
		"X-Api-Key":         []string{"secret-key"},
		"X-Goog-Api-Key":    []string{"goog-secret"},
		"Cookie":            []string{"session=secret"},
		"Host":              []string{"internal.example"},
		"Transfer-Encoding": []string{"chunked"},
		"Content-Length":    []string{"999"},
		"X-Forwarded-For":   []string{"1.2.3.4"},
	})

	if got := headers.Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected allowed content-type header, got %q", got)
	}
	for _, blocked := range []string{"Authorization", "X-Api-Key", "X-Goog-Api-Key", "Cookie", "Host", "Transfer-Encoding", "Content-Length", "X-Forwarded-For"} {
		if got := headers.Get(blocked); got != "" {
			t.Fatalf("expected blocked header %s to be removed, got %q", blocked, got)
		}
	}
}

func TestForward_OpenAIToClaudeTranslation(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"anthropic","authType":"apiKey","apiKey":"upstream-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	var seenRequest map[string]any
	h := requestHandler{
		resolver:  staticResolveClient{response: resolve.Response{Provider: "anthropic", Model: "claude-sonnet-4", ChosenConnectionID: "conn-a"}},
		reporter:  &capturingReporter{},
		credReader: credentialsReaderForTest(credPath),
		httpClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			body, _ := io.ReadAll(req.Body)
			_ = json.Unmarshal(body, &seenRequest)
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"hi there"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":4}}`))}, nil
		})},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4.1","messages":[{"role":"user","content":"hello"}]}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()

	h.handleProxy(rr, req, "openai")

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if _, ok := seenRequest["anthropic_version"]; !ok {
		t.Fatalf("expected translated Claude request, got %#v", seenRequest)
	}
	var response map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal translated response: %v", err)
	}
	if response["object"] != "chat.completion" {
		t.Fatalf("expected openai response object, got %#v", response["object"])
	}
	choices := response["choices"].([]any)
	message := choices[0].(map[string]any)["message"].(map[string]any)
	if message["content"] != "hi there" {
		t.Fatalf("expected translated response content, got %#v", message["content"])
	}
}

func TestForward_ClaudeToOpenAITranslation(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"openai","authType":"apiKey","apiKey":"upstream-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	var seenRequest map[string]any
	h := requestHandler{
		resolver:  staticResolveClient{response: resolve.Response{Provider: "openai", Model: "gpt-4.1", ChosenConnectionID: "conn-a"}},
		reporter:  &capturingReporter{},
		credReader: credentialsReaderForTest(credPath),
		httpClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			body, _ := io.ReadAll(req.Body)
			_ = json.Unmarshal(body, &seenRequest)
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"id":"chatcmpl_1","object":"chat.completion","model":"gpt-4.1","choices":[{"index":0,"message":{"role":"assistant","content":"hello back"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}`))}, nil
		})},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4","anthropic_version":"2023-06-01","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()

	h.handleProxy(rr, req, "anthropic")

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if _, ok := seenRequest["messages"]; !ok || seenRequest["anthropic_version"] != nil {
		t.Fatalf("expected translated openai request, got %#v", seenRequest)
	}
	var response map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal translated response: %v", err)
	}
	if response["type"] != "message" {
		t.Fatalf("expected claude response type, got %#v", response["type"])
	}
	content := response["content"].([]any)
	if content[0].(map[string]any)["text"] != "hello back" {
		t.Fatalf("expected translated claude content, got %#v", content)
	}
}

func TestForward_OpenAIToGeminiTranslation(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"gemini","authType":"apiKey","apiKey":"upstream-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	var seenRequest map[string]any
	h := requestHandler{
		resolver:  staticResolveClient{response: resolve.Response{Provider: "gemini", Model: "gemini-2.5-pro", ChosenConnectionID: "conn-a"}},
		reporter:  &capturingReporter{},
		credReader: credentialsReaderForTest(credPath),
		httpClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			body, _ := io.ReadAll(req.Body)
			_ = json.Unmarshal(body, &seenRequest)
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"responseId":"resp_1","modelVersion":"gemini-2.5-pro","candidates":[{"content":{"role":"model","parts":[{"text":"gemini hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}`))}, nil
		})},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4.1","messages":[{"role":"user","content":"hello"}]}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()

	h.handleProxy(rr, req, "openai")

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if _, ok := seenRequest["contents"]; !ok {
		t.Fatalf("expected translated gemini request, got %#v", seenRequest)
	}
	var response map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal translated response: %v", err)
	}
	if response["object"] != "chat.completion" {
		t.Fatalf("expected openai response object, got %#v", response["object"])
	}
}

func TestForward_StreamingTranslation(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"anthropic","authType":"apiKey","apiKey":"upstream-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	h := requestHandler{
		resolver:  staticResolveClient{response: resolve.Response{Provider: "anthropic", Model: "claude-sonnet-4", ChosenConnectionID: "conn-a"}},
		reporter:  &capturingReporter{},
		credReader: credentialsReaderForTest(credPath),
		httpClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			payload := strings.Join([]string{
				"data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_123\",\"model\":\"claude-sonnet-4\"}}",
				"",
				"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}",
				"",
				"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}",
				"",
				"data: {\"type\":\"message_stop\"}",
				"",
			}, "\n")
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(payload))}, nil
		})},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4.1","stream":true,"messages":[{"role":"user","content":"hello"}]}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()

	h.handleProxy(rr, req, "openai")

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	body := rr.Body.String()
	if !strings.Contains(body, `"object":"chat.completion.chunk"`) {
		t.Fatalf("expected translated openai stream chunk, got %q", body)
	}
	if !strings.Contains(body, `data: [DONE]`) {
		t.Fatalf("expected done frame, got %q", body)
	}
}

func TestStreamingTranslationConcurrentRead(t *testing.T) {
	payload := strings.Join([]string{
		"data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_123\",\"model\":\"claude-sonnet-4\"}}",
		"",
		"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}",
		"",
		"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}",
		"",
		"data: {\"type\":\"message_stop\"}",
		"",
	}, "\n")

	stream := newTranslatedStream(context.Background(), io.NopCloser(strings.NewReader(payload)), "claude", "openai", "claude-sonnet-4")
	t.Cleanup(func() { _ = stream.Close() })

	var wg sync.WaitGroup
	var total atomic.Int64
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, 16)
			for {
				n, err := stream.Read(buf)
				if n > 0 {
					total.Add(int64(n))
				}
				if err != nil {
					if err == io.EOF {
						return
					}
					t.Errorf("unexpected read error: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()

	if total.Load() == 0 {
		t.Fatal("expected translated stream bytes to be read")
	}
}

func TestStreamingTranslationClosesUpstreamOnTranslationError(t *testing.T) {
	upstream := &trackingReadCloser{Reader: strings.NewReader("data: not-json\n\n")}
	stream := newTranslatedStream(context.Background(), upstream, "claude", "openai", "claude-sonnet-4")

	buf := make([]byte, 64)
	_, err := stream.Read(buf)
	if err == nil {
		t.Fatal("expected translation error")
	}
	if !strings.Contains(err.Error(), "stream translation failed") {
		t.Fatalf("expected wrapped translation error, got %v", err)
	}
	if upstream.closeCount.Load() == 0 {
		t.Fatal("expected upstream to be closed on translation error")
	}
}

func TestForward_TranslationErrorHandling(t *testing.T) {
	credPath := filepath.Join(t.TempDir(), "db.json")
	if err := os.WriteFile(credPath, []byte(`{"providerConnections":[{"id":"conn-a","provider":"anthropic","authType":"apiKey","apiKey":"upstream-key"}]}`), 0o600); err != nil {
		t.Fatalf("write credentials file: %v", err)
	}

	h := requestHandler{
		resolver:  staticResolveClient{response: resolve.Response{Provider: "anthropic", Model: "claude-sonnet-4", ChosenConnectionID: "conn-a"}},
		reporter:  &capturingReporter{},
		credReader: credentialsReaderForTest(credPath),
		httpClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4","content":"invalid"}`))}, nil
		})},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4.1","messages":[{"role":"user","content":"hello"}]}`))
	req.Header.Set("Authorization", "Bearer sk-public")
	rr := httptest.NewRecorder()

	h.handleProxy(rr, req, "openai")

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on translation error, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "translation failed") {
		t.Fatalf("expected translation error message, got %q", rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "upstream status 200") {
		t.Fatalf("expected upstream status in translation error message, got %q", rr.Body.String())
	}
}

func TestStreaming_TranslatedStreamReadHonorsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	stream := &translatedStream{
		ctx:      ctx,
		upstream: io.NopCloser(strings.NewReader("")),
		reader:   bufio.NewReader(strings.NewReader("")),
	}

	buf := make([]byte, 1)
	_, err := stream.Read(buf)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context canceled error, got %v", err)
	}
}

func TestStreaming_TranslatedStreamReadFrameRejectsOversizedFrames(t *testing.T) {
	oversized := bytes.Repeat([]byte("a"), maxFrameSize+1)
	stream := &translatedStream{
		ctx:      context.Background(),
		upstream: io.NopCloser(strings.NewReader("")),
		reader:   bufio.NewReader(bytes.NewReader(append(oversized, '\n'))),
	}

	_, err := stream.readFrame()
	if err == nil {
		t.Fatal("expected oversized frame error")
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("%d", maxFrameSize)) {
		t.Fatalf("expected max frame size in error, got %v", err)
	}
}

func TestStreaming_TranslatedStreamCloseIsIdempotent(t *testing.T) {
	upstream := &countingReadCloser{Reader: strings.NewReader("")}
	stream := &translatedStream{upstream: upstream}

	if err := stream.Close(); err != nil {
		t.Fatalf("first close failed: %v", err)
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("second close failed: %v", err)
	}
	if upstream.closeCalls != 1 {
		t.Fatalf("expected upstream to close once, got %d", upstream.closeCalls)
	}
}

func TestForward_NormalizeProviderFormatMappings(t *testing.T) {
	if got := normalizeProviderFormat(provider.FormatGeminiCLI); got != "gemini" {
		t.Fatalf("expected gemini mapping, got %q", got)
	}
}

func TestTranslateRequestBody_RejectsEmptyBody(t *testing.T) {
	_, _, err := translateRequestBody(nil, resolve.Response{Provider: "openai", Model: "gpt-4.1"}, false)
	if err == nil || !strings.Contains(err.Error(), "empty request body") {
		t.Fatalf("expected empty body error, got %v", err)
	}
}

func TestTranslateRequestBody_PreservesOpenAIResponsesSourceFormat(t *testing.T) {
	body := []byte(`{"model":"gpt-4.1","input":"hello"}`)
	format, translated, err := translateRequestBody(body, resolve.Response{Provider: "codex", Model: "gpt-4.1"}, false)
	if err != nil {
		t.Fatalf("translate request body: %v", err)
	}
	if format != translate.FormatOpenAIResponses {
		t.Fatalf("expected source format %q, got %q", translate.FormatOpenAIResponses, format)
	}
	if string(translated) != string(body) {
		t.Fatalf("expected body to remain unchanged, got %s", string(translated))
	}
}

func TestExtractFrameData_UsesFirstDataLineOnly(t *testing.T) {
	payload, ok := extractFrameData([]byte("event: message\ndata: first\ndata: second\n\n"))
	if !ok {
		t.Fatal("expected frame data to be extracted")
	}
	if string(payload) != "first" {
		t.Fatalf("expected first data line, got %q", string(payload))
	}
}

func TestExtractFrameData_DoneStopsProcessing(t *testing.T) {
	payload, ok := extractFrameData([]byte("data: [DONE]\n\n"))
	if ok || payload != nil {
		t.Fatalf("expected done frame to stop processing, got payload=%q ok=%t", string(payload), ok)
	}
}

func TestTranslatedStreamReadFrame_ReturnsUnexpectedEOFForIncompleteEvent(t *testing.T) {
	s := &translatedStream{reader: bufio.NewReader(strings.NewReader("event: message"))}
	frame, err := s.readFrame()
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected unexpected EOF, got frame=%q err=%v", string(frame), err)
	}
}

func TestTranslatedStreamReadFrame_AllowsEOFWithDataFrame(t *testing.T) {
	s := &translatedStream{reader: bufio.NewReader(strings.NewReader("data: {\"ok\":true}"))}
	frame, err := s.readFrame()
	if err != nil {
		t.Fatalf("expected complete frame at EOF, got %v", err)
	}
	if !bytes.Contains(frame, []byte("data:")) {
		t.Fatalf("expected data frame, got %q", string(frame))
	}
}

func TestTranslateStreamFrame_ReusesStateAcrossMultiHop(t *testing.T) {
	state := &translate.StreamState{}
	frame := []byte("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":1,\"candidatesTokenCount\":1,\"totalTokenCount\":2}}\n\n")

	translatedFrame, err := translateStreamFrame(frame, translate.FormatGemini, translate.FormatClaude, state, "claude-sonnet-4")
	if err != nil {
		t.Fatalf("translate stream frame: %v", err)
	}
	if len(translatedFrame) == 0 {
		t.Fatal("expected translated frame")
	}
	if state.Model == "" {
		t.Fatal("expected shared state to be updated during translation")
	}
}

func TestStreamEvidenceCapture_KeepsTrailingWindow(t *testing.T) {
	capture := &streamEvidenceCapture{maxSize: 64, sseLike: true}
	_, _ = capture.Write([]byte(strings.Repeat("x", 80)))
	_, _ = capture.Write([]byte("\ndata: {\"usage\":{\"prompt_tokens\":9}}\n\n"))

	usage, _ := capture.Evidence()
	if usage == nil {
		t.Fatal("expected usage from trailing SSE window")
	}
	if got, ok := usage["prompt_tokens"].(float64); !ok || int(got) != 9 {
		t.Fatalf("expected prompt_tokens=9, got %#v", usage["prompt_tokens"])
	}
}

func TestSanitizeClientErrorMessage_RedactsSensitiveValues(t *testing.T) {
	msg := sanitizeClientErrorMessage("upstream Bearer secret-token failed for sk-abc123 at http://10.0.0.1:8080/v1/chat/completions")
	for _, forbidden := range []string{"Bearer secret-token", "sk-abc123", "10.0.0.1", "http://10.0.0.1:8080/v1/chat/completions"} {
		if strings.Contains(msg, forbidden) {
			t.Fatalf("expected sanitized message to remove %q, got %q", forbidden, msg)
		}
	}
	if msg == "" {
		t.Fatal("expected non-empty sanitized message")
	}
}

func TestSanitizeClientErrorMessage_TruncatesAtTwoHundredCharacters(t *testing.T) {
	msg := sanitizeClientErrorMessage(strings.Repeat("a", 250))
	if len(msg) != 203 {
		t.Fatalf("expected 203-char truncated message including ellipsis, got %d", len(msg))
	}
	if !strings.HasSuffix(msg, "...") {
		t.Fatalf("expected truncated message to end with ellipsis, got %q", msg)
	}
}

func TestIsHopByHopHeader_IsCaseInsensitive(t *testing.T) {
	if !isHopByHopHeader("Transfer-Encoding") {
		t.Fatal("expected mixed-case transfer-encoding header to be treated as hop-by-hop")
	}
}

func TestGenerateRequestID_HasExpectedPrefixAndLength(t *testing.T) {
	id := generateRequestID()
	if !strings.HasPrefix(id, "req_") {
		t.Fatalf("expected request id prefix req_, got %q", id)
	}
	if len(id) != 20 {
		t.Fatalf("expected request id length 20, got %d", len(id))
	}
}

func credentialsReaderForTest(path string) *credentials.Reader {
	return credentials.NewReader(path)
}

func mustLoadModelStore(t *testing.T, path string) *model.Store {
	t.Helper()

	store, err := model.LoadStore(path)
	if err != nil {
		t.Fatalf("load model store: %v", err)
	}

	return store
}

type staticResolveClient struct {
	response resolve.Response
	err      error
}

type countingReadCloser struct {
	io.Reader
	closeCalls int
}

func (c *countingReadCloser) Close() error {
	c.closeCalls++
	return nil
}

func (s staticResolveClient) Resolve(context.Context, resolve.ResolveRequest) (resolve.Response, error) {
	if s.err != nil {
		return resolve.Response{}, s.err
	}
	return s.response, nil
}

type capturingReporter struct {
	calls int
	last  report.OutcomePayload
}

func (c *capturingReporter) ReportOutcome(_ context.Context, payload report.OutcomePayload) error {
	c.calls++
	c.last = payload
	return nil
}

type contextInspectingReporter struct {
	calls              int
	lastCtxErr         error
	lastCtxHasDeadline bool
}

func (c *contextInspectingReporter) ReportOutcome(ctx context.Context, _ report.OutcomePayload) error {
	c.calls++
	c.lastCtxErr = ctx.Err()
	_, c.lastCtxHasDeadline = ctx.Deadline()
	return nil
}

type failingRoundTripper struct {
	err error
}

func (f failingRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, f.err
}

type staticResponseRoundTripper struct {
	resp *http.Response
	err  error
}

func (s staticResponseRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.resp, nil
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type trackingReadCloser struct {
	io.Reader
	closeCount atomic.Int32
}

func (t *trackingReadCloser) Close() error {
	t.closeCount.Add(1)
	return nil
}
