package resolve

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

const internalAuthHeader = "x-internal-auth"

// Response models the resolver result for a given API key.
type Response struct {
	Provider              string
	Model                 string
	ChosenConnectionID    string
	FallbackConnectionIDs []string
}

// Client resolves provider/model details for a public request shape.
type Client interface {
	Resolve(ctx context.Context, req ResolveRequest) (Response, error)
}

// ResolveRequest is the normalized resolve payload sent to 9router.
type ResolveRequest struct {
	Provider       string `json:"provider"`
	Model          string `json:"model"`
	ProtocolFamily string `json:"protocolFamily"`
	PublicPath     string `json:"publicPath"`
}

type resolveResponse struct {
	OK         bool `json:"ok"`
	Resolution struct {
		Provider         string `json:"provider"`
		Model            string `json:"model"`
		ChosenConnection struct {
			ConnectionID string `json:"connectionId"`
		} `json:"chosenConnection"`
		FallbackChain []struct {
			ConnectionID string `json:"connectionId"`
		} `json:"fallbackChain"`
	} `json:"resolution"`
}

// HTTPClient calls the internal resolve endpoint on 9router.
type HTTPClient struct {
	BaseURL      string
	InternalAuth string
	HTTPClient   *http.Client
}

func (c HTTPClient) Resolve(ctx context.Context, req ResolveRequest) (Response, error) {
	if strings.TrimSpace(req.Provider) == "" || strings.TrimSpace(req.Model) == "" || strings.TrimSpace(req.ProtocolFamily) == "" || strings.TrimSpace(req.PublicPath) == "" {
		return Response{}, fmt.Errorf("resolve request is missing required fields")
	}

	body, err := json.Marshal(req)
	if err != nil {
		return Response{}, fmt.Errorf("marshal resolve request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.BaseURL, "/")+"/api/internal/proxy/resolve", bytes.NewReader(body))
	if err != nil {
		return Response{}, fmt.Errorf("build resolve request: %w", err)
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
		return Response{}, fmt.Errorf("call resolve endpoint: %w", err)
	}
	defer httpResp.Body.Close()

	if httpResp.StatusCode >= http.StatusBadRequest {
		return Response{}, fmt.Errorf("resolve endpoint status %d", httpResp.StatusCode)
	}

	var payload resolveResponse
	if err := json.NewDecoder(httpResp.Body).Decode(&payload); err != nil {
		return Response{}, fmt.Errorf("decode resolve response: %w", err)
	}
	if !payload.OK {
		return Response{}, fmt.Errorf("resolve endpoint returned not ok")
	}
	if strings.TrimSpace(payload.Resolution.ChosenConnection.ConnectionID) == "" {
		return Response{}, fmt.Errorf("resolve response missing chosen connection")
	}

	fallbackIDs := make([]string, 0, len(payload.Resolution.FallbackChain))
	for _, item := range payload.Resolution.FallbackChain {
		if strings.TrimSpace(item.ConnectionID) == "" {
			continue
		}
		fallbackIDs = append(fallbackIDs, item.ConnectionID)
	}

	return Response{
		Provider:              payload.Resolution.Provider,
		Model:                 payload.Resolution.Model,
		ChosenConnectionID:    payload.Resolution.ChosenConnection.ConnectionID,
		FallbackConnectionIDs: fallbackIDs,
	}, nil
}
