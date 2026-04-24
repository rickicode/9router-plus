package proxy

import (
	"context"
	"io"
	"net/http"
)

// ResolveResult contains the upstream URL selection and optional fallback chain.
type ResolveResult struct {
	UpstreamURL   string
	AllowFallback bool
	FallbackChain []string
}

// Resolver resolves the upstream URL for an API key.
type Resolver interface {
	Resolve(ctx context.Context, apiKey string) (ResolveResult, error)
}

// ForwardRequest represents an incoming request to be forwarded upstream.
type ForwardRequest struct {
	Method string
	Path   string
	Query  string
	Header http.Header
	Body   []byte
	APIKey string
	Stream bool
}

type ForwardOutcome string

const (
	OutcomeOK    ForwardOutcome = "ok"
	OutcomeError ForwardOutcome = "error"
)

// ForwardError describes a normalized upstream forwarding failure.
type ForwardError struct {
	Message string
	Phase   string
}

// ForwardResponse represents the upstream response returned to the caller.
type ForwardResponse struct {
	StatusCode        int
	Header            http.Header
	Body              []byte
	BodyStream        io.ReadCloser
	Outcome           ForwardOutcome
	Error             *ForwardError
	StreamInterrupted bool
	UsageEvidence     map[string]any
	QuotasEvidence    map[string]any
}

// Forwarder forwards requests to resolved upstream URLs.
type Forwarder interface {
	Forward(ctx context.Context, req ForwardRequest) (ForwardResponse, error)
}
