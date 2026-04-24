package report

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

const internalAuthHeader = "x-internal-auth"

// ErrorPayload contains normalized failure details sent to internal report ingestion.
type ErrorPayload struct {
	Message string `json:"message,omitempty"`
	Phase   string `json:"phase,omitempty"`
}

// OutcomePayload is the normalized request outcome sent to 9router internal report API.
type OutcomePayload struct {
	RequestID         string         `json:"requestId,omitempty"`
	Provider          string         `json:"provider,omitempty"`
	ConnectionID      string         `json:"connectionId,omitempty"`
	Model             string         `json:"model,omitempty"`
	ProtocolFamily    string         `json:"protocolFamily,omitempty"`
	PublicPath        string         `json:"publicPath,omitempty"`
	Method            string         `json:"method,omitempty"`
	UpstreamStatus    int            `json:"upstreamStatus,omitempty"`
	LatencyMs         int64          `json:"latencyMs,omitempty"`
	Outcome           string         `json:"outcome,omitempty"`
	StreamInterrupted bool           `json:"streamInterrupted,omitempty"`
	Usage             map[string]any `json:"usage,omitempty"`
	Quotas            map[string]any `json:"quotas,omitempty"`
	Error             *ErrorPayload  `json:"error,omitempty"`
}

// Client reports normalized outcomes back to internal 9router report ingestion.
type Client interface {
	ReportOutcome(ctx context.Context, payload OutcomePayload) error
}

// HTTPClient posts normalized outcomes to 9router internal report endpoint.
type HTTPClient struct {
	BaseURL      string
	InternalAuth string
	HTTPClient   *http.Client
}

func (c HTTPClient) ReportOutcome(ctx context.Context, payload OutcomePayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal report payload: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.BaseURL, "/")+"/api/internal/proxy/report", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build report request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(c.InternalAuth) != "" {
		httpReq.Header.Set(internalAuthHeader, c.InternalAuth)
	}

	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}

	httpResp, err := client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("call report endpoint: %w", err)
	}
	defer httpResp.Body.Close()

	if httpResp.StatusCode >= http.StatusBadRequest {
		return fmt.Errorf("report endpoint status %d", httpResp.StatusCode)
	}

	return nil
}

var NoopClient Client = noopClient{}

type noopClient struct{}

func (noopClient) ReportOutcome(context.Context, OutcomePayload) error {
	return nil
}

var _ Client = noopClient{}

var _ Client = HTTPClient{}
