package proxy

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
)

func normalizeForwardError(err error, phase string) *ForwardError {
	if err == nil {
		return nil
	}
	return &ForwardError{Message: err.Error(), Phase: phase}
}

// HTTPForwarder forwards requests to a resolved upstream URL.
type HTTPForwarder struct {
	Resolver Resolver
	Client   *http.Client
}

// Forward forwards requests to the resolved upstream.
func (f HTTPForwarder) Forward(ctx context.Context, req ForwardRequest) (ForwardResponse, error) {
	resolved, err := f.Resolver.Resolve(ctx, req.APIKey)
	if err != nil {
		return ForwardResponse{}, err
	}

	targets := []string{resolved.UpstreamURL}
	if resolved.AllowFallback && len(resolved.FallbackChain) > 0 {
		targets = resolved.FallbackChain
	}
	if len(targets) == 0 {
		return ForwardResponse{}, errors.New("no upstream targets available")
	}

	for i, target := range targets {
		resp, forwardErr := f.forwardToTarget(ctx, req, target)
		if forwardErr != nil {
			if !resolved.AllowFallback || i == len(targets)-1 {
				return resp, forwardErr
			}
			continue
		}
		if resp.Outcome == OutcomeOK || i == len(targets)-1 {
			return resp, nil
		}
	}

	return ForwardResponse{}, errors.New("failed to forward request")
}

func (f HTTPForwarder) forwardToTarget(ctx context.Context, req ForwardRequest, target string) (ForwardResponse, error) {
	endpoint, err := url.Parse(target)
	if err != nil {
		return ForwardResponse{}, err
	}

	if req.Path != "" {
		endpoint.Path = req.Path
	}
	if req.Query != "" {
		endpoint.RawQuery = req.Query
	}

	httpReq, err := http.NewRequestWithContext(ctx, req.Method, endpoint.String(), bytes.NewReader(req.Body))
	if err != nil {
		return ForwardResponse{}, err
	}

	for k, vals := range req.Header {
		for _, v := range vals {
			httpReq.Header.Add(k, v)
		}
	}

	client := f.Client
	if client == nil {
		client = http.DefaultClient
	}

	httpResp, err := client.Do(httpReq)
	if err != nil {
		return ForwardResponse{}, err
	}

	response := ForwardResponse{
		StatusCode: httpResp.StatusCode,
		Header:     httpResp.Header.Clone(),
		Outcome:    OutcomeOK,
	}

	if httpResp.StatusCode >= http.StatusBadRequest {
		response.Outcome = OutcomeError
	}

	if req.Stream {
		response.BodyStream = httpResp.Body
		if response.Outcome == OutcomeError {
			response.Error = &ForwardError{
				Message: http.StatusText(httpResp.StatusCode),
				Phase:   "upstream",
			}
		}
		return response, nil
	}
	defer httpResp.Body.Close()

	body, readErr := io.ReadAll(httpResp.Body)
	response.Body = body
	if readErr != nil {
		response.Error = normalizeForwardError(readErr, "response")
		return response, readErr
	}

	return response, nil
}
