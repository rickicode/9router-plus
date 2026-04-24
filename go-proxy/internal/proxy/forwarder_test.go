package proxy

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeResolver struct {
	result ResolveResult
	err    error
}

func (f fakeResolver) Resolve(_ context.Context, _ string) (ResolveResult, error) {
	return f.result, f.err
}

func TestHTTPForwarder_ForwardsNonStreamRequestToResolvedURL(t *testing.T) {
	t.Parallel()

	var gotMethod string
	var gotPath string
	var gotBody string
	var gotHeader string

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotHeader = r.Header.Get("Content-Type")
		bytes, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("failed reading upstream body: %v", err)
		}
		gotBody = string(bytes)

		w.Header().Set("X-Upstream", "ok")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"resp-1"}`))
	}))
	defer upstream.Close()

	forwarder := HTTPForwarder{
		Resolver: fakeResolver{result: ResolveResult{UpstreamURL: upstream.URL + "/v1/messages"}},
	}

	resp, err := forwarder.Forward(context.Background(), ForwardRequest{
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   []byte(`{"prompt":"hello"}`),
		APIKey: "key-123",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if gotMethod != http.MethodPost {
		t.Fatalf("expected method POST, got %q", gotMethod)
	}

	if gotPath != "/v1/messages" {
		t.Fatalf("expected path /v1/messages, got %q", gotPath)
	}

	if gotHeader != "application/json" {
		t.Fatalf("expected content type application/json, got %q", gotHeader)
	}

	if gotBody != `{"prompt":"hello"}` {
		t.Fatalf("expected forwarded body, got %q", gotBody)
	}

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected status %d, got %d", http.StatusCreated, resp.StatusCode)
	}

	if string(resp.Body) != `{"id":"resp-1"}` {
		t.Fatalf("expected response body from upstream, got %q", string(resp.Body))
	}

	if resp.Header.Get("X-Upstream") != "ok" {
		t.Fatalf("expected upstream header to be returned, got %q", resp.Header.Get("X-Upstream"))
	}
}

func TestHTTPForwarder_StreamingRequestReturnsBodyStreamWithoutBuffering(t *testing.T) {
	t.Parallel()

	started := make(chan struct{})
	release := make(chan struct{})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			_, _ = w.Write([]byte("data: first\n\n"))
			f.Flush()
		}
		close(started)
		<-release
		_, _ = w.Write([]byte("data: second\n\n"))
	}))
	defer upstream.Close()

	forwarder := HTTPForwarder{
		Resolver: fakeResolver{result: ResolveResult{UpstreamURL: upstream.URL + "/v1/messages"}},
		Client:   upstream.Client(),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	resp, err := forwarder.Forward(ctx, ForwardRequest{
		Method: http.MethodPost,
		Stream: true,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   []byte(`{"stream":true}`),
		APIKey: "key-stream-1",
	})
	if err != nil {
		t.Fatalf("expected no forward error for stream setup, got %v", err)
	}
	if resp.BodyStream == nil {
		t.Fatalf("expected body stream to be returned for stream request")
	}
	if len(resp.Body) != 0 {
		t.Fatalf("expected stream body not to be buffered")
	}

	select {
	case <-started:
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("expected upstream stream to start")
	}

	first := make([]byte, len("data: first\n\n"))
	if _, err := io.ReadFull(resp.BodyStream, first); err != nil {
		t.Fatalf("expected to read first chunk from stream, got %v", err)
	}
	if string(first) != "data: first\n\n" {
		t.Fatalf("unexpected first chunk: %q", string(first))
	}

	close(release)
	all, readErr := io.ReadAll(resp.BodyStream)
	_ = resp.BodyStream.Close()
	if readErr != nil {
		t.Fatalf("expected stream read to complete, got %v", readErr)
	}
	if !strings.Contains(string(all), "data: second") {
		t.Fatalf("expected second chunk in remaining stream, got %q", string(all))
	}
}

func TestHTTPForwarder_StreamingRequestUpstreamDropIsObservedByStreamReader(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to start listener: %v", err)
	}
	defer ln.Close()

	wroteResponse := make(chan struct{})

	go func() {
		conn, acceptErr := ln.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()

		reader := bufio.NewReader(conn)
		req, reqErr := http.ReadRequest(reader)
		if reqErr != nil {
			return
		}
		if req.Body != nil {
			_, _ = io.Copy(io.Discard, req.Body)
			_ = req.Body.Close()
		}

		_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\n" +
			"Content-Type: text/event-stream\r\n" +
			"Transfer-Encoding: chunked\r\n" +
			"\r\n" +
			"10\r\n" +
			"data: {\"delta\":\"a\"}\n\n\r\n"))
		close(wroteResponse)
		time.Sleep(50 * time.Millisecond)
	}()

	forwarder := HTTPForwarder{
		Resolver: fakeResolver{result: ResolveResult{UpstreamURL: "http://" + ln.Addr().String() + "/v1/messages"}},
		Client:   &http.Client{},
	}

	resp, err := forwarder.Forward(context.Background(), ForwardRequest{
		Method: http.MethodPost,
		Stream: true,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   []byte(`{"stream":true}`),
		APIKey: "key-stream-drop",
	})
	if err != nil {
		t.Fatalf("expected no immediate forward error, got %v", err)
	}
	if resp.BodyStream == nil {
		t.Fatalf("expected stream reader")
	}

	select {
	case <-wroteResponse:
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("expected upstream response to be written")
	}

	_, readErr := io.ReadAll(resp.BodyStream)
	_ = resp.BodyStream.Close()
	if readErr == nil {
		t.Fatalf("expected stream read error from truncated upstream")
	}
	errText := strings.ToLower(readErr.Error())
	if !strings.Contains(errText, "unexpected eof") && !strings.Contains(errText, "chunk") {
		t.Fatalf("expected upstream stream truncation error, got %v", readErr)
	}
}
func TestHTTPForwarder_AllowFallback_UsesFallbackChainInReturnedOrder(t *testing.T) {
	t.Parallel()

	order := make([]string, 0, 2)

	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		order = append(order, "first")
		http.Error(w, "upstream failed", http.StatusBadGateway)
	}))
	defer first.Close()

	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		order = append(order, "second")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer second.Close()

	forwarder := HTTPForwarder{
		Resolver: fakeResolver{result: ResolveResult{
			UpstreamURL:   first.URL + "/v1/messages",
			AllowFallback: true,
			FallbackChain: []string{first.URL + "/v1/messages", second.URL + "/v1/messages"},
		}},
	}

	resp, err := forwarder.Forward(context.Background(), ForwardRequest{
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   []byte(`{"prompt":"hello"}`),
		APIKey: "key-fallback-order",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if len(order) != 2 {
		t.Fatalf("expected two upstream attempts, got %v", order)
	}
	if order[0] != "first" || order[1] != "second" {
		t.Fatalf("expected order [first second], got %v", order)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected final status 200 from second target, got %d", resp.StatusCode)
	}
}

func TestHTTPForwarder_AllowFallback_EmptyChain_UsesPrimaryUpstream(t *testing.T) {
	t.Parallel()

	primaryCalls := 0
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		primaryCalls++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer primary.Close()

	forwarder := HTTPForwarder{
		Resolver: fakeResolver{result: ResolveResult{
			UpstreamURL:   primary.URL + "/v1/messages",
			AllowFallback: true,
			FallbackChain: []string{},
		}},
	}

	resp, err := forwarder.Forward(context.Background(), ForwardRequest{
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   []byte(`{"prompt":"hello"}`),
		APIKey: "key-fallback-empty-chain",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if primaryCalls != 1 {
		t.Fatalf("expected primary upstream to be called once, got %d", primaryCalls)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200 from primary upstream, got %d", resp.StatusCode)
	}
}

func TestHTTPForwarder_AllowFallback_ContinuesAfterTransportError(t *testing.T) {
	t.Parallel()

	failedListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to reserve listener: %v", err)
	}
	failedAddr := failedListener.Addr().String()
	_ = failedListener.Close()

	order := make([]string, 0, 1)
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		order = append(order, "second")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer second.Close()

	forwarder := HTTPForwarder{
		Resolver: fakeResolver{result: ResolveResult{
			UpstreamURL:   "http://" + failedAddr + "/v1/messages",
			AllowFallback: true,
			FallbackChain: []string{"http://" + failedAddr + "/v1/messages", second.URL + "/v1/messages"},
		}},
		Client: &http.Client{},
	}

	resp, err := forwarder.Forward(context.Background(), ForwardRequest{
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   []byte(`{"prompt":"hello"}`),
		APIKey: "key-fallback-transport",
	})
	if err != nil {
		t.Fatalf("expected fallback success after transport error, got %v", err)
	}

	if len(order) != 1 || order[0] != "second" {
		t.Fatalf("expected fallback target to be attempted in order after transport failure, got %v", order)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected final status 200 from second target, got %d", resp.StatusCode)
	}
}

func TestHTTPForwarder_AllowFallbackFalse_TriesPrimaryOnly(t *testing.T) {
	t.Parallel()

	firstCalls := 0
	secondCalls := 0

	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		firstCalls++
		http.Error(w, "upstream failed", http.StatusBadGateway)
	}))
	defer first.Close()

	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secondCalls++
		w.WriteHeader(http.StatusOK)
	}))
	defer second.Close()

	forwarder := HTTPForwarder{
		Resolver: fakeResolver{result: ResolveResult{
			UpstreamURL:   first.URL + "/v1/messages",
			AllowFallback: false,
			FallbackChain: []string{first.URL + "/v1/messages", second.URL + "/v1/messages"},
		}},
	}

	resp, err := forwarder.Forward(context.Background(), ForwardRequest{
		Method: http.MethodPost,
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   []byte(`{"prompt":"hello"}`),
		APIKey: "key-no-fallback",
	})
	if err != nil {
		t.Fatalf("expected no transport error, got %v", err)
	}

	if firstCalls != 1 {
		t.Fatalf("expected first target one call, got %d", firstCalls)
	}
	if secondCalls != 0 {
		t.Fatalf("expected no fallback calls, got %d", secondCalls)
	}
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected status from first target, got %d", resp.StatusCode)
	}
}
