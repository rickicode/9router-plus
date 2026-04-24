package http

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"os"
	"strings"
	"sync"
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

const (
	routeChatCompletions = "/v1/chat/completions"
	routeResponses       = "/v1/responses"
	routeMessages        = "/v1/messages"
	reportTimeout        = 3 * time.Second
	maxFrameSize         = 1024 * 1024 // 1MB
)

var (
	clientErrorURLPattern    = regexp.MustCompile(`https?://[^\s"']+`)
	clientErrorIPPattern     = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)
	clientErrorBearerPattern = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+\-/=]+`)
	clientErrorSKPattern     = regexp.MustCompile(`\bsk-[A-Za-z0-9._\-]+\b`)
	allowedForwardHeaders    = map[string]struct{}{
		"accept":          {},
		"accept-encoding": {},
		"content-type":    {},
		"user-agent":      {},
	}
)

// NewRoutes returns the HTTP routes for the Go data-plane proxy.
func NewRoutes(cfg config.Config) http.Handler {
	mux := http.NewServeMux()

	resolverClient := resolve.HTTPClient{
		BaseURL:      cfg.NineRouterBaseURL,
		InternalAuth: cfg.InternalResolveAuthToken,
		HTTPClient: &http.Client{
			Timeout: time.Duration(cfg.HTTPTimeoutSeconds) * time.Second,
		},
	}

	reportClient := report.HTTPClient{
		BaseURL:      cfg.NineRouterBaseURL,
		InternalAuth: cfg.InternalReportAuthToken,
		HTTPClient: &http.Client{
			Timeout: time.Duration(cfg.HTTPTimeoutSeconds) * time.Second,
		},
	}

	credReader := credentials.NewReader(cfg.CredentialsFilePath)
	modelStore, _ := model.LoadStore(cfg.CredentialsFilePath)

	h := requestHandler{
		resolver:            resolverClient,
		reporter:            reportClient,
		credReader:          credReader,
		credentialsFilePath: cfg.CredentialsFilePath,
		modelStore:          modelStore,
		httpClient:          &http.Client{Timeout: time.Duration(cfg.HTTPTimeoutSeconds) * time.Second},
	}

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	mux.HandleFunc(routeChatCompletions, h.handleOpenAI)
	mux.HandleFunc(routeResponses, h.handleOpenAI)
	mux.HandleFunc(routeMessages, h.handleAnthropic)

	return mux
}

type requestHandler struct {
	resolver            resolve.Client
	reporter            report.Client
	credReader          *credentials.Reader
	credentialsFilePath string
	modelStore          *model.Store
	httpClient          *http.Client
}

func (h requestHandler) handleOpenAI(w http.ResponseWriter, r *http.Request) {
	h.handleProxy(w, r, "openai")
}

func (h requestHandler) handleAnthropic(w http.ResponseWriter, r *http.Request) {
	h.handleProxy(w, r, "anthropic")
}

func (h requestHandler) reportOutcome(payload report.OutcomePayload) {
	ctx, cancel := context.WithTimeout(context.Background(), reportTimeout)
	defer cancel()
	_ = h.reporter.ReportOutcome(ctx, payload)
}

func (h requestHandler) handleProxy(w http.ResponseWriter, r *http.Request, protocolFamily string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	requestID := generateRequestID()

	apiKey := readPublicAPIKey(r)
	if apiKey == "" {
		http.Error(w, "missing api key", http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	model, stream, err := extractModelAndStream(body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	resolved, statusCode, err := h.resolveRequest(r.Context(), model, protocolFamily, r.URL.Path)
	if err != nil {
		http.Error(w, err.Error(), statusCode)
		return
	}

	result, usedConnectionID, err := h.forwardResolved(r, body, stream, apiKey, resolved, protocolFamily)
	if err != nil {
		statusCode := http.StatusBadGateway
		if isTranslationError(err) {
			statusCode = http.StatusInternalServerError
		}
		normalized := proxy.NormalizeOutcome(result, err)
		usageEvidence, quotasEvidence := extractResponseEvidence(result)
		h.reportOutcome(report.OutcomePayload{
			RequestID:         requestID,
			Provider:          resolved.Provider,
			ConnectionID:      usedConnectionID,
			Model:             resolved.Model,
			ProtocolFamily:    protocolFamily,
			PublicPath:        r.URL.Path,
			Method:            r.Method,
			UpstreamStatus:    normalized.UpstreamStatus,
			LatencyMs:         0,
			Outcome:           string(normalized.Outcome),
			StreamInterrupted: normalized.StreamInterrupted,
			Usage:             usageEvidence,
			Quotas:            quotasEvidence,
			Error:             mapForwardError(normalized.Error),
		})
		http.Error(w, sanitizeClientErrorMessage(err.Error()), statusCode)
		return
	}

	for key, values := range result.Header {
		if isHopByHopHeader(key) {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(result.StatusCode)

	var transportErr error
	if result.BodyStream != nil {
		usageCapture := newStreamEvidenceCapture(result.Header)
		streamReader := io.TeeReader(result.BodyStream, usageCapture)
		_, transportErr = io.Copy(w, streamReader)
		_ = result.BodyStream.Close()
		result.UsageEvidence, result.QuotasEvidence = usageCapture.Evidence()
		if transportErr != nil {
			result.StreamInterrupted = true
			if result.Error == nil {
				result.Error = &proxy.ForwardError{Message: transportErr.Error(), Phase: "stream"}
			}
		}
	} else {
		_, transportErr = w.Write(result.Body)
	}

	normalized := proxy.NormalizeOutcome(result, transportErr)
	usageEvidence, quotasEvidence := extractResponseEvidence(result)
	h.reportOutcome(report.OutcomePayload{
		RequestID:         requestID,
		Provider:          resolved.Provider,
		ConnectionID:      usedConnectionID,
		Model:             resolved.Model,
		ProtocolFamily:    protocolFamily,
		PublicPath:        r.URL.Path,
		Method:            r.Method,
		UpstreamStatus:    normalized.UpstreamStatus,
		LatencyMs:         0,
		Outcome:           string(normalized.Outcome),
		StreamInterrupted: normalized.StreamInterrupted,
		Usage:             usageEvidence,
		Quotas:            quotasEvidence,
		Error:             mapForwardError(normalized.Error),
	})
}

func (h requestHandler) resolveRequest(ctx context.Context, modelStr, protocolFamily, publicPath string) (resolve.Response, int, error) {
	if h.resolver != nil {
		resolved, err := h.resolver.Resolve(ctx, resolve.ResolveRequest{
			Provider:       protocolFamily,
			Model:          modelStr,
			ProtocolFamily: protocolFamily,
			PublicPath:     publicPath,
		})
		if err != nil {
			return resolve.Response{}, http.StatusBadGateway, errors.New("resolve failed")
		}
		return resolved, 0, nil
	}

	if h.modelStore == nil {
		return resolve.Response{}, http.StatusBadGateway, errors.New("model store unavailable")
	}

	resolvedModel, err := model.ResolveModel(modelStr, h.modelStore)
	if err != nil {
		return resolve.Response{}, http.StatusBadRequest, fmt.Errorf("invalid model: %w", err)
	}
	if resolvedModel.IsCombo {
		return resolve.Response{}, http.StatusBadRequest, errors.New("combo models are not supported")
	}

	cred, err := readCredentialByProvider(h.credentialsFilePath, resolvedModel.Provider)
	if err != nil {
		return resolve.Response{}, http.StatusBadGateway, errors.New("provider credentials not found")
	}

	return resolve.Response{
		Provider:           resolvedModel.Provider,
		Model:              resolvedModel.Model,
		ChosenConnectionID: cred.ConnectionID,
	}, 0, nil
}

func (h requestHandler) forwardResolved(r *http.Request, body []byte, stream bool, _ string, resolved resolve.Response, protocolFamily string) (proxy.ForwardResponse, string, error) {
	if resolved.ChosenConnectionID == "" {
		return proxy.ForwardResponse{}, "", fmt.Errorf("missing resolved primary connection")
	}

	sourceFormat, translatedBody, err := translateRequestBody(body, resolved, stream)
	if err != nil {
		return proxy.ForwardResponse{}, "", err
	}
	body = translatedBody
	targetFormat := normalizeProviderFormat(provider.GetTargetFormat(resolved.Provider))

	targetIDs := append([]string{resolved.ChosenConnectionID}, resolved.FallbackConnectionIDs...)
	targets := make([]resolvedTarget, 0, len(targetIDs))
	for _, connectionID := range targetIDs {
		if strings.TrimSpace(connectionID) == "" {
			continue
		}
		cred, err := h.credReader.ReadByConnectionID(connectionID)
		if err != nil {
			continue
		}
		upstreamURL, forwardHeaders, err := h.buildProviderRequest(r, resolved, cred, stream)
		if err != nil {
			continue
		}
		targets = append(targets, resolvedTarget{connectionID: connectionID, upstreamURL: upstreamURL, credential: cred, headers: forwardHeaders})
	}
	if len(targets) == 0 {
		return proxy.ForwardResponse{}, "", fmt.Errorf("no routable upstream targets")
	}

	var lastResp proxy.ForwardResponse
	var lastErr error
	var lastConnectionID string
	for i, target := range targets {
		forwarder := proxy.HTTPForwarder{
			Resolver: staticResolver{result: proxy.ResolveResult{UpstreamURL: target.upstreamURL}},
			Client:   h.httpClient,
		}

		resp, err := forwarder.Forward(r.Context(), proxy.ForwardRequest{
			Method: r.Method,
			Path:   "",
			Query:  r.URL.RawQuery,
			Header: target.headers,
			Body:   body,
			APIKey: target.connectionID,
			Stream: stream,
		})
		if err == nil {
			if translateErr := translateForwardResponse(&resp, sourceFormat, targetFormat, resolved.Model, stream); translateErr != nil {
				return resp, target.connectionID, fmt.Errorf("translation failed (upstream status %d): %w", resp.StatusCode, translateErr)
			}
		}
		lastResp, lastErr = resp, err
		lastConnectionID = target.connectionID
		if err == nil && resp.Outcome == proxy.OutcomeOK {
			return resp, target.connectionID, nil
		}
		if i == len(targets)-1 {
			return resp, target.connectionID, err
		}
	}

	if lastErr != nil {
		return lastResp, lastConnectionID, lastErr
	}
	return lastResp, lastConnectionID, nil
}

func translateRequestBody(body []byte, resolved resolve.Response, stream bool) (string, []byte, error) {
	if len(body) == 0 {
		return "", nil, fmt.Errorf("empty request body")
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", nil, fmt.Errorf("translation failed: request body is not valid JSON: %w", err)
	}

	sourceFormat := translate.DetectFormat(payload)
	targetFormat := normalizeProviderFormat(provider.GetTargetFormat(resolved.Provider))
	if equivalentTranslateFormat(sourceFormat, targetFormat) {
		return sourceFormat, body, nil
	}

	translated, err := translate.TranslateRequest(canonicalTranslateFormat(sourceFormat), canonicalTranslateFormat(targetFormat), payload, translate.TranslateOptions{
		Model:    resolved.Model,
		Stream:   stream,
		Provider: resolved.Provider,
	})
	if err != nil {
		return "", nil, fmt.Errorf("translation failed: request translation: %w", err)
	}

	encoded, err := json.Marshal(translated)
	if err != nil {
		return "", nil, fmt.Errorf("translation failed: marshal translated request: %w", err)
	}

	log.Printf("translate: request %s -> %s for provider=%s model=%s stream=%t", sourceFormat, targetFormat, resolved.Provider, resolved.Model, stream)
	return sourceFormat, encoded, nil
}

func translateForwardResponse(resp *proxy.ForwardResponse, sourceFormat, targetFormat, model string, stream bool) error {
	if resp == nil || sourceFormat == targetFormat {
		return nil
	}

	if stream {
		if resp.BodyStream == nil {
			return nil
		}
		log.Printf("translate: streaming response %s -> %s for model=%s", targetFormat, sourceFormat, model)
		resp.BodyStream = newTranslatedStream(context.Background(), resp.BodyStream, targetFormat, sourceFormat, model)
		resp.Header.Set("Content-Type", "text/event-stream")
		return nil
	}

	if len(resp.Body) == 0 {
		return nil
	}

	translated, err := translateResponseBody(resp.Body, targetFormat, sourceFormat, model)
	if err != nil {
		return fmt.Errorf("translation failed: response translation: %w", err)
	}
	resp.Body = translated
	resp.Header.Set("Content-Type", "application/json")
	log.Printf("translate: response %s -> %s for model=%s", targetFormat, sourceFormat, model)
	return nil
}

func isTranslationError(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "translation failed")
}

func normalizeProviderFormat(format provider.TargetFormat) string {
	switch format {
	case provider.FormatClaude:
		return translate.FormatClaude
	case provider.FormatGemini, provider.FormatGeminiCLI, provider.FormatAntigravity:
		return translate.FormatGemini
	case provider.FormatOpenAI, provider.FormatOpenAIResponses, provider.FormatVertex:
		return translate.FormatOpenAI
	default:
		return translate.FormatOpenAI
	}
}

func normalizeTranslateFormat(format string) string {
	return canonicalTranslateFormat(format)
}

func canonicalTranslateFormat(format string) string {
	switch format {
	case translate.FormatOpenAIResponses:
		return translate.FormatOpenAI
	case translate.FormatGeminiCLI, translate.FormatAntigravity:
		return translate.FormatGemini
	default:
		return format
	}
}

func equivalentTranslateFormat(left, right string) bool {
	return canonicalTranslateFormat(left) == canonicalTranslateFormat(right)
}

func translateResponseBody(body []byte, fromFormat, toFormat, model string) ([]byte, error) {
	if equivalentTranslateFormat(fromFormat, toFormat) {
		return body, nil
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("invalid JSON body: %w", err)
	}

	openAIResponse, err := responseToOpenAI(payload, fromFormat, model)
	if err != nil {
		return nil, err
	}
	translated, err := openAIResponseToFormat(openAIResponse, toFormat, model)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(translated)
	if err != nil {
		return nil, fmt.Errorf("marshal translated response: %w", err)
	}
	return encoded, nil
}

func responseToOpenAI(payload map[string]any, fromFormat, model string) (map[string]any, error) {
	switch fromFormat {
	case translate.FormatOpenAI, translate.FormatOpenAIResponses:
		return payload, nil
	case translate.FormatClaude:
		if _, ok := payload["content"].([]any); !ok && payload["content"] != nil {
			return nil, fmt.Errorf("invalid claude response content")
		}
		return claudeResponseToOpenAI(payload, model), nil
	case translate.FormatGemini, translate.FormatGeminiCLI, translate.FormatAntigravity:
		if candidate := firstCandidateLocal(payload); candidate != nil {
			if content, ok := candidate["content"].(map[string]any); ok && content["parts"] != nil {
				if _, ok := content["parts"].([]any); !ok {
					return nil, fmt.Errorf("invalid gemini response parts")
				}
			}
		}
		return geminiResponseToOpenAI(payload, model), nil
	default:
		return nil, fmt.Errorf("unsupported response source format: %s", fromFormat)
	}
}

func openAIResponseToFormat(payload map[string]any, toFormat, model string) (map[string]any, error) {
	switch toFormat {
	case translate.FormatOpenAI, translate.FormatOpenAIResponses:
		return payload, nil
	case translate.FormatClaude:
		return openAIResponseToClaude(payload, model), nil
	case translate.FormatGemini, translate.FormatGeminiCLI, translate.FormatAntigravity:
		return openAIResponseToGemini(payload, model), nil
	default:
		return nil, fmt.Errorf("unsupported response target format: %s", toFormat)
	}
}

func claudeResponseToOpenAI(payload map[string]any, model string) map[string]any {
	messageID := stringValueAny(payload["id"])
	if messageID == "" {
		messageID = fmt.Sprintf("chatcmpl-%d", time.Now().UnixMilli())
	}
	content := extractClaudeResponseText(payload)
	finishReason := convertClaudeStopReasonLocal(stringValueAny(payload["stop_reason"]))
	if finishReason == "" {
		finishReason = "stop"
	}
	response := map[string]any{
		"id":      messageID,
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   valueOrDefaultString(stringValueAny(payload["model"]), model),
		"choices": []any{map[string]any{
			"index": 0,
			"message": map[string]any{
				"role":    "assistant",
				"content": content,
			},
			"finish_reason": finishReason,
		}},
	}
	if usage, ok := payload["usage"].(map[string]any); ok {
		promptTokens := intValueAny(usage["input_tokens"], 0) + intValueAny(usage["cache_read_input_tokens"], 0) + intValueAny(usage["cache_creation_input_tokens"], 0)
		completionTokens := intValueAny(usage["output_tokens"], 0)
		response["usage"] = map[string]any{
			"prompt_tokens":     promptTokens,
			"completion_tokens": completionTokens,
			"total_tokens":      promptTokens + completionTokens,
		}
	}
	return response
}

func geminiResponseToOpenAI(payload map[string]any, model string) map[string]any {
	response := map[string]any{
		"id":      valueOrDefaultString(stringValueAny(payload["responseId"]), fmt.Sprintf("chatcmpl-%d", time.Now().UnixMilli())),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   valueOrDefaultString(stringValueAny(payload["modelVersion"]), model),
		"choices": []any{map[string]any{
			"index": 0,
			"message": map[string]any{
				"role":    "assistant",
				"content": extractGeminiResponseText(payload),
			},
			"finish_reason": convertGeminiFinishReasonLocal(stringValueAny(firstCandidateLocal(payload)["finishReason"]), false),
		}},
	}
	if usage, ok := payload["usageMetadata"].(map[string]any); ok {
		promptTokens := intValueAny(usage["promptTokenCount"], 0)
		completionTokens := intValueAny(usage["candidatesTokenCount"], 0) + intValueAny(usage["thoughtsTokenCount"], 0)
		totalTokens := intValueAny(usage["totalTokenCount"], promptTokens+completionTokens)
		response["usage"] = map[string]any{
			"prompt_tokens":     promptTokens,
			"completion_tokens": completionTokens,
			"total_tokens":      totalTokens,
		}
	}
	return response
}

func openAIResponseToClaude(payload map[string]any, model string) map[string]any {
	content := extractOpenAIResponseText(payload)
	message := map[string]any{
		"id":          valueOrDefaultString(stringValueAny(payload["id"]), fmt.Sprintf("msg_%d", time.Now().UnixMilli())),
		"type":       "message",
		"role":       "assistant",
		"model":       valueOrDefaultString(stringValueAny(payload["model"]), model),
		"content":    []any{map[string]any{"type": "text", "text": content}},
		"stop_reason": openAIToClaudeStopReason(payload),
		"stop_sequence": nil,
	}
	if usage, ok := payload["usage"].(map[string]any); ok {
		message["usage"] = map[string]any{
			"input_tokens":  intValueAny(usage["prompt_tokens"], 0),
			"output_tokens": intValueAny(usage["completion_tokens"], 0),
		}
	}
	return message
}

func openAIResponseToGemini(payload map[string]any, model string) map[string]any {
	result := map[string]any{
		"responseId":   valueOrDefaultString(stringValueAny(payload["id"]), fmt.Sprintf("resp_%d", time.Now().UnixMilli())),
		"modelVersion": valueOrDefaultString(stringValueAny(payload["model"]), model),
		"candidates": []any{map[string]any{
			"content": map[string]any{
				"role":  "model",
				"parts": []any{map[string]any{"text": extractOpenAIResponseText(payload)}},
			},
			"finishReason": openAIToGeminiFinishReason(payload),
		}},
	}
	if usage, ok := payload["usage"].(map[string]any); ok {
		result["usageMetadata"] = map[string]any{
			"promptTokenCount":     intValueAny(usage["prompt_tokens"], 0),
			"candidatesTokenCount": intValueAny(usage["completion_tokens"], 0),
			"totalTokenCount":      intValueAny(usage["total_tokens"], intValueAny(usage["prompt_tokens"], 0)+intValueAny(usage["completion_tokens"], 0)),
		}
	}
	return result
}

func extractClaudeResponseText(payload map[string]any) string {
	content, _ := payload["content"].([]any)
	parts := make([]string, 0, len(content))
	for _, raw := range content {
		block, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch stringValueAny(block["type"]) {
		case "text":
			if text := stringValueAny(block["text"]); text != "" {
				parts = append(parts, text)
			}
		case "tool_result":
			parts = append(parts, stringifyAny(block["content"]))
		}
	}
	return strings.Join(parts, "")
}

func extractGeminiResponseText(payload map[string]any) string {
	candidate := firstCandidateLocal(payload)
	if candidate == nil {
		return ""
	}
	content, _ := candidate["content"].(map[string]any)
	parts, _ := content["parts"].([]any)
	texts := make([]string, 0, len(parts))
	for _, raw := range parts {
		part, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if text := stringValueAny(part["text"]); text != "" {
			texts = append(texts, text)
		}
	}
	return strings.Join(texts, "")
}

func extractOpenAIResponseText(payload map[string]any) string {
	choices, _ := payload["choices"].([]any)
	if len(choices) == 0 {
		return ""
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)
	if text := stringValueAny(message["content"]); text != "" {
		return text
	}
	if parts, ok := message["content"].([]any); ok {
		texts := make([]string, 0, len(parts))
		for _, raw := range parts {
			part, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if text := stringValueAny(part["text"]); text != "" {
				texts = append(texts, text)
			}
		}
		return strings.Join(texts, "")
	}
	return ""
}

func openAIToClaudeStopReason(payload map[string]any) string {
	finishReason := extractOpenAIFinishReason(payload)
	switch finishReason {
	case "length":
		return "max_tokens"
	case "tool_calls":
		return "tool_use"
	default:
		return "end_turn"
	}
}

func openAIToGeminiFinishReason(payload map[string]any) string {
	finishReason := extractOpenAIFinishReason(payload)
	switch finishReason {
	case "length":
		return "MAX_TOKENS"
	case "content_filter":
		return "SAFETY"
	default:
		return "STOP"
	}
}

func extractOpenAIFinishReason(payload map[string]any) string {
	choices, _ := payload["choices"].([]any)
	if len(choices) == 0 {
		return ""
	}
	choice, _ := choices[0].(map[string]any)
	return stringValueAny(choice["finish_reason"])
}

func stringifyAny(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case nil:
		return ""
	default:
		encoded, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprint(v)
		}
		return string(encoded)
	}
}

type translatedStream struct {
	mu         sync.Mutex
	ctx        context.Context
	upstream   io.ReadCloser
	reader     *bufio.Reader
	buffer     bytes.Buffer
	fromFormat string
	toFormat   string
	state      *translate.StreamState
	model      string
	doneSent   bool
	closeOnce  sync.Once
}

func newTranslatedStream(ctx context.Context, upstream io.ReadCloser, fromFormat, toFormat, model string) io.ReadCloser {
	if ctx == nil {
		ctx = context.Background()
	}
	return &translatedStream{
		upstream:   upstream,
		ctx:        ctx,
		reader:     bufio.NewReader(upstream),
		fromFormat: normalizeTranslateFormat(fromFormat),
		toFormat:   normalizeTranslateFormat(toFormat),
		state:      &translate.StreamState{Model: model},
		model:      model,
	}
}

func (s *translatedStream) Read(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for s.buffer.Len() == 0 {
		select {
		case <-s.ctx.Done():
			return 0, s.ctx.Err()
		default:
		}
		if err := s.fill(); err != nil {
			if err == io.EOF && s.buffer.Len() > 0 {
				break
			}
			return 0, err
		}
	}
	return s.buffer.Read(p)
}

func (s *translatedStream) Close() error {
	var err error
	s.closeOnce.Do(func() {
		if s.upstream != nil {
			err = s.upstream.Close()
		}
	})
	return err
}

func (s *translatedStream) fill() error {
	if s.upstream == nil {
		return io.EOF
	}
	frame, err := s.readFrame()
	if err != nil {
		if err == io.EOF && !s.doneSent && s.toFormat == translate.FormatOpenAI {
			s.buffer.WriteString("data: [DONE]\n\n")
			s.doneSent = true
			return nil
		}
		return err
	}
	translated, err := translateStreamFrame(frame, s.fromFormat, s.toFormat, s.state, s.model)
	if err != nil {
		_ = s.Close()
		return fmt.Errorf("stream translation failed: %w", err)
	}
	if len(translated) == 0 {
		return nil
	}
	s.buffer.Write(translated)
	return nil
}

func (s *translatedStream) readFrame() ([]byte, error) {
	var frame bytes.Buffer
	for {
		if frame.Len() > maxFrameSize {
			return nil, fmt.Errorf("SSE frame exceeds maximum size of %d bytes", maxFrameSize)
		}
		line, err := s.reader.ReadBytes('\n')
		if len(line) > 0 {
			frame.Write(line)
			if frame.Len() > maxFrameSize {
				return nil, fmt.Errorf("SSE frame exceeds maximum size of %d bytes", maxFrameSize)
			}
			if bytes.Equal(bytes.TrimSpace(line), []byte("")) {
				return frame.Bytes(), nil
			}
		}
		if err != nil {
			if err == io.EOF && frame.Len() > 0 {
				if !bytes.Contains(frame.Bytes(), []byte("data:")) {
					return nil, io.ErrUnexpectedEOF
				}
				return frame.Bytes(), nil
			}
			return nil, err
		}
	}
}

func translateStreamFrame(frame []byte, fromFormat, toFormat string, state *translate.StreamState, model string) ([]byte, error) {
	if equivalentTranslateFormat(fromFormat, toFormat) {
		return frame, nil
	}
	canonicalFrom := canonicalTranslateFormat(fromFormat)
	canonicalTo := canonicalTranslateFormat(toFormat)
	if canonicalTo == translate.FormatOpenAI {
		return translateStreamFrameToOpenAI(frame, canonicalFrom, state)
	}
	if canonicalFrom == translate.FormatOpenAI {
		return translateOpenAIStreamFrame(frame, canonicalTo, state, model)
	}
	openAIFrame, err := translateStreamFrameToOpenAI(frame, canonicalFrom, state)
	if err != nil || len(openAIFrame) == 0 {
		return openAIFrame, err
	}
	return translateOpenAIStreamFrame(openAIFrame, canonicalTo, state, model)
}

func translateStreamFrameToOpenAI(frame []byte, fromFormat string, state *translate.StreamState) ([]byte, error) {
	var translated []byte
	var err error
	switch fromFormat {
	case translate.FormatClaude:
		payload, ok := extractFrameData(frame)
		if !ok {
			return nil, nil
		}
		translated, err = translate.ClaudeToOpenAIChunk(payload, state)
	case translate.FormatGemini:
		translated, err = translate.GeminiToOpenAIChunk(frame, state)
	default:
		return nil, fmt.Errorf("unsupported streaming source format: %s", fromFormat)
	}
	if err != nil || len(translated) == 0 {
		return translated, err
	}
	return []byte("data: " + string(translated) + "\n\n"), nil
}

func translateOpenAIStreamFrame(frame []byte, toFormat string, state *translate.StreamState, model string) ([]byte, error) {
	payload, ok := extractFrameData(frame)
	if !ok {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(payload), []byte("[DONE]")) {
		return nil, io.EOF
	}

	var chunk map[string]any
	if err := json.Unmarshal(payload, &chunk); err != nil {
		return nil, fmt.Errorf("unmarshal openai chunk: %w", err)
	}

	switch toFormat {
	case translate.FormatClaude:
		return openAIChunkToClaudeSSE(chunk, state, model)
	case translate.FormatGemini:
		return openAIChunkToGeminiSSE(chunk, state, model)
	default:
		return nil, fmt.Errorf("unsupported streaming target format: %s", toFormat)
	}
}

func extractFrameData(frame []byte) ([]byte, bool) {
	lines := strings.Split(string(frame), "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "data:") {
			data := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
			if data == "[DONE]" {
				return nil, false
			}
			return []byte(data), true
		}
	}
	{
		trimmed := strings.TrimSpace(string(frame))
		if trimmed == "" {
			return nil, false
		}
		return []byte(trimmed), true
	}
}

func openAIChunkToClaudeSSE(chunk map[string]any, state *translate.StreamState, model string) ([]byte, error) {
	choices, _ := chunk["choices"].([]any)
	if len(choices) == 0 {
		return nil, nil
	}
	choice, _ := choices[0].(map[string]any)
	delta, _ := choice["delta"].(map[string]any)
	finishReason := stringValueAny(choice["finish_reason"])
	messageID := valueOrDefaultString(state.MessageID, valueOrDefaultString(strings.TrimPrefix(stringValueAny(chunk["id"]), "chatcmpl-"), fmt.Sprintf("msg_%d", time.Now().UnixMilli())))
	state.MessageID = messageID
	if state.Model == "" {
		state.Model = valueOrDefaultString(stringValueAny(chunk["model"]), model)
	}

	events := make([]string, 0, 4)
	if !state.TextBlockStarted {
		start, _ := json.Marshal(map[string]any{"type": "message_start", "message": map[string]any{"id": messageID, "type": "message", "role": "assistant", "model": valueOrDefaultString(state.Model, model)}})
		events = append(events, "data: "+string(start)+"\n\n")
		if text := stringValueAny(delta["content"]); text != "" {
			blockStart, _ := json.Marshal(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
			events = append(events, "data: "+string(blockStart)+"\n\n")
			state.TextBlockStarted = true
		}
	}
	if text := stringValueAny(delta["content"]); text != "" {
		if !state.TextBlockStarted {
			blockStart, _ := json.Marshal(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
			events = append(events, "data: "+string(blockStart)+"\n\n")
			state.TextBlockStarted = true
		}
		deltaChunk, _ := json.Marshal(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}})
		events = append(events, "data: "+string(deltaChunk)+"\n\n")
	}
	if finishReason != "" {
		if state.TextBlockStarted {
			blockStop, _ := json.Marshal(map[string]any{"type": "content_block_stop", "index": 0})
			events = append(events, "data: "+string(blockStop)+"\n\n")
		}
		messageDelta := map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": openAIToClaudeStopReason(map[string]any{"choices": []any{choice}})}}
		if usage, ok := chunk["usage"].(map[string]any); ok {
			messageDelta["usage"] = map[string]any{
				"input_tokens":  intValueAny(usage["prompt_tokens"], 0),
				"output_tokens": intValueAny(usage["completion_tokens"], 0),
			}
		}
		messageDeltaJSON, _ := json.Marshal(messageDelta)
		messageStop, _ := json.Marshal(map[string]any{"type": "message_stop"})
		events = append(events, "data: "+string(messageDeltaJSON)+"\n\n", "data: "+string(messageStop)+"\n\n")
		state.TextBlockStarted = false
	}
	return []byte(strings.Join(events, "")), nil
}

func openAIChunkToGeminiSSE(chunk map[string]any, state *translate.StreamState, model string) ([]byte, error) {
	choices, _ := chunk["choices"].([]any)
	if len(choices) == 0 {
		return nil, nil
	}
	choice, _ := choices[0].(map[string]any)
	delta, _ := choice["delta"].(map[string]any)
	finishReason := stringValueAny(choice["finish_reason"])
	responseID := valueOrDefaultString(state.MessageID, valueOrDefaultString(stringValueAny(chunk["id"]), fmt.Sprintf("resp_%d", time.Now().UnixMilli())))
	state.MessageID = responseID
	state.Model = valueOrDefaultString(state.Model, valueOrDefaultString(stringValueAny(chunk["model"]), model))

	responses := make([]string, 0, 2)
	if text := stringValueAny(delta["content"]); text != "" {
		body, _ := json.Marshal(map[string]any{
			"responseId":   responseID,
			"modelVersion": state.Model,
			"candidates": []any{map[string]any{
				"content": map[string]any{"role": "model", "parts": []any{map[string]any{"text": text}}},
			}},
		})
		responses = append(responses, "data: "+string(body)+"\n\n")
	}
	if finishReason != "" {
		final := map[string]any{
			"responseId":   responseID,
			"modelVersion": state.Model,
			"candidates":   []any{map[string]any{"finishReason": openAIToGeminiFinishReason(map[string]any{"choices": []any{choice}})}},
		}
		if usage, ok := chunk["usage"].(map[string]any); ok {
			final["usageMetadata"] = map[string]any{
				"promptTokenCount":     intValueAny(usage["prompt_tokens"], 0),
				"candidatesTokenCount": intValueAny(usage["completion_tokens"], 0),
				"totalTokenCount":      intValueAny(usage["total_tokens"], intValueAny(usage["prompt_tokens"], 0)+intValueAny(usage["completion_tokens"], 0)),
			}
		}
		body, _ := json.Marshal(final)
		responses = append(responses, "data: "+string(body)+"\n\n")
	}
	return []byte(strings.Join(responses, "")), nil
}

func stringValueAny(value any) string {
	if str, ok := value.(string); ok {
		return str
	}
	return ""
}

func valueOrDefaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func intValueAny(value any, fallback int) int {
	switch v := value.(type) {
	case int:
		return v
	case int8:
		return int(v)
	case int16:
		return int(v)
	case int32:
		return int(v)
	case int64:
		return int(v)
	case uint:
		return int(v)
	case uint8:
		return int(v)
	case uint16:
		return int(v)
	case uint32:
		return int(v)
	case uint64:
		return int(v)
	case float32:
		return int(v)
	case float64:
		return int(v)
	default:
		return fallback
	}
}

func firstCandidateLocal(payload map[string]any) map[string]any {
	candidates, _ := payload["candidates"].([]any)
	if len(candidates) == 0 {
		return nil
	}
	candidate, _ := candidates[0].(map[string]any)
	return candidate
}

func convertClaudeStopReasonLocal(reason string) string {
	switch reason {
	case "end_turn", "stop_sequence", "":
		return "stop"
	case "max_tokens":
		return "length"
	case "tool_use":
		return "tool_calls"
	default:
		return "stop"
	}
}

func convertGeminiFinishReasonLocal(reason string, hasToolCalls bool) string {
	switch strings.ToUpper(reason) {
	case "STOP", "":
		if hasToolCalls {
			return "tool_calls"
		}
		return "stop"
	case "MAX_TOKENS":
		return "length"
	case "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII":
		return "content_filter"
	case "MALFORMED_FUNCTION_CALL":
		return "tool_calls"
	default:
		return strings.ToLower(reason)
	}
}

type resolvedTarget struct {
	connectionID string
	upstreamURL  string
	credential   credentials.Credential
	headers      http.Header
}

func (h requestHandler) buildProviderRequest(r *http.Request, resolved resolve.Response, credential credentials.Credential, stream bool) (string, http.Header, error) {
	options := provider.BuildOptions{Credential: credential, RegistryHeaders: cloneForwardHeaders(r.Header)}
	if node, ok := lookupProviderNode(h.modelStore, resolved.Provider); ok {
		options.BaseURL = node.BaseURL
	}

	if _, ok := provider.GetConfig(resolved.Provider); !ok && strings.TrimSpace(options.BaseURL) == "" {
		return "", nil, fmt.Errorf("unknown provider: %s", resolved.Provider)
	}

	upstreamURL, err := provider.BuildURL(resolved.Provider, resolved.Model, stream, options)
	if err != nil {
		return "", nil, err
	}

	return upstreamURL, provider.BuildHeaders(resolved.Provider, stream, options), nil
}

func cloneForwardHeaders(header http.Header) http.Header {
	cloned := make(http.Header)
	for key, values := range header {
		if _, ok := allowedForwardHeaders[strings.ToLower(strings.TrimSpace(key))]; !ok {
			continue
		}
		cloned[key] = append([]string(nil), values...)
	}
	return cloned
}

func sanitizeClientErrorMessage(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return "upstream forwarding failed"
	}
	message = clientErrorURLPattern.ReplaceAllString(message, "[redacted-url]")
	message = clientErrorIPPattern.ReplaceAllString(message, "[redacted-ip]")
	message = clientErrorBearerPattern.ReplaceAllString(message, "Bearer [redacted-token]")
	message = clientErrorSKPattern.ReplaceAllString(message, "[redacted-token]")
	message = strings.TrimSpace(message)
	if message == "" {
		return "upstream forwarding failed"
	}
	if len(message) > 200 {
		message = message[:200] + "..."
	}
	if message == "[redacted-url]" || message == "[redacted-ip]" {
		return "upstream forwarding failed"
	}
	return message
}


func lookupProviderNode(store *model.Store, providerID string) (model.ProviderNode, bool) {
	if store == nil {
		return model.ProviderNode{}, false
	}
	for _, nodeType := range []string{"openai-compatible", "anthropic-compatible"} {
		for _, node := range store.ProviderNodesByType(nodeType) {
			if node.ID == providerID {
				return node, true
			}
		}
	}
	return model.ProviderNode{}, false
}

func readCredentialByProvider(path, providerID string) (credentials.Credential, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return credentials.Credential{}, err
	}

	var decoded struct {
		ProviderConnections []struct {
			ID           string `json:"id"`
			Provider     string `json:"provider"`
			AuthType     string `json:"authType"`
			APIKey       string `json:"apiKey"`
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
		} `json:"providerConnections"`
	}
	if err := json.Unmarshal(content, &decoded); err != nil {
		return credentials.Credential{}, err
	}

	for _, connection := range decoded.ProviderConnections {
		if strings.TrimSpace(connection.Provider) != providerID {
			continue
		}
		return credentials.Credential{
			ConnectionID: connection.ID,
			Provider:     connection.Provider,
			AuthType:     connection.AuthType,
			APIKey:       connection.APIKey,
			AccessToken:  connection.AccessToken,
			RefreshToken: connection.RefreshToken,
		}, nil
	}

	return credentials.Credential{}, credentials.ErrConnectionNotFound
}

func extractResponseEvidence(resp proxy.ForwardResponse) (map[string]any, map[string]any) {
	if resp.UsageEvidence != nil {
		return resp.UsageEvidence, resp.QuotasEvidence
	}
	return extractUsageAndQuotasFromPayload(resp.Body)
}

func extractUsageAndQuotasFromPayload(body []byte) (map[string]any, map[string]any) {
	if len(body) == 0 {
		return nil, nil
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, nil
	}

	usage, usageOK := payload["usage"].(map[string]any)
	if !usageOK {
		return nil, nil
	}

	quotas, quotasOK := payload["quotas"].(map[string]any)
	if !quotasOK {
		if nestedQuotas, nestedOK := usage["quotas"].(map[string]any); nestedOK {
			quotas = nestedQuotas
		}
	}

	return usage, quotas
}

func newStreamEvidenceCapture(header http.Header) *streamEvidenceCapture {
	contentType := strings.ToLower(strings.TrimSpace(header.Get("Content-Type")))
	return &streamEvidenceCapture{
		maxSize: 64 * 1024,
		sseLike: strings.Contains(contentType, "text/event-stream"),
	}
}

type streamEvidenceCapture struct {
	ring    []byte
	pos     int
	size    int
	maxSize int
	sseLike bool
	usage   map[string]any
	quotas  map[string]any
}

func (c *streamEvidenceCapture) Write(p []byte) (int, error) {
	if c.usage != nil {
		return len(p), nil
	}
	if c.maxSize <= 0 {
		c.maxSize = 64 * 1024
	}
	if len(c.ring) != c.maxSize {
		c.ring = make([]byte, c.maxSize)
	}
	if len(p) >= c.maxSize {
		copy(c.ring, p[len(p)-c.maxSize:])
		c.pos = 0
		c.size = c.maxSize
		c.scan()
		return len(p), nil
	}
	for _, b := range p {
		c.ring[c.pos] = b
		c.pos = (c.pos + 1) % c.maxSize
		if c.size < c.maxSize {
			c.size++
		}
	}
	c.scan()
	return len(p), nil
}

func (c *streamEvidenceCapture) Evidence() (map[string]any, map[string]any) {
	if c.usage != nil {
		return c.usage, c.quotas
	}
	c.scan()
	return c.usage, c.quotas
}

func (c *streamEvidenceCapture) scan() {
	if c.usage != nil {
		return
	}
	data := c.bytes()
	if len(data) == 0 {
		return
	}
	if c.sseLike {
		usage, quotas := extractUsageAndQuotasFromSSE(data)
		if usage != nil {
			c.usage, c.quotas = usage, quotas
			return
		}
	}
	usage, quotas := extractUsageAndQuotasFromPayload(data)
	if usage != nil {
		c.usage, c.quotas = usage, quotas
	}
}

func (c *streamEvidenceCapture) bytes() []byte {
	if c.size == 0 || len(c.ring) == 0 {
		return nil
	}
	if c.size < len(c.ring) {
		return append([]byte(nil), c.ring[:c.size]...)
	}
	data := make([]byte, c.size)
	copy(data, c.ring[c.pos:])
	copy(data[len(c.ring)-c.pos:], c.ring[:c.pos])
	return data
}

func extractUsageAndQuotasFromSSE(data []byte) (map[string]any, map[string]any) {
	lines := strings.Split(string(data), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		chunk := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if chunk == "" || chunk == "[DONE]" {
			continue
		}
		usage, quotas := extractUsageAndQuotasFromPayload([]byte(chunk))
		if usage != nil {
			return usage, quotas
		}
	}
	return nil, nil
}

func readPublicAPIKey(r *http.Request) string {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[len("Bearer "):])
	}
	if key := strings.TrimSpace(r.Header.Get("x-api-key")); key != "" {
		return key
	}
	if key := strings.TrimSpace(r.Header.Get("X-Api-Key")); key != "" {
		return key
	}
	return ""
}

func extractModelAndStream(body []byte) (string, bool, error) {
	if len(body) == 0 {
		return "", false, fmt.Errorf("model field is required")
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", false, err
	}
	model, _ := payload["model"].(string)
	model = strings.TrimSpace(model)
	if model == "" {
		return "", false, fmt.Errorf("model field is required")
	}
	stream, _ := payload["stream"].(bool)
	return model, stream, nil
}

func buildUpstreamURL(provider, publicPath string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "openai":
		return "https://api.openai.com" + publicPath
	case "anthropic", "claude":
		return "https://api.anthropic.com" + publicPath
	default:
		return ""
	}
}

func applyUpstreamAuth(header *http.Header, protocolFamily string, credential credentials.Credential) {
	if strings.ToLower(protocolFamily) == "anthropic" {
		if strings.TrimSpace(credential.APIKey) != "" {
			header.Set("x-api-key", credential.APIKey)
		}
		if strings.TrimSpace(credential.AccessToken) != "" {
			header.Set("Authorization", "Bearer "+credential.AccessToken)
		}
		header.Set("anthropic-version", "2023-06-01")
		return
	}
	if strings.TrimSpace(credential.APIKey) != "" {
		header.Set("Authorization", "Bearer "+credential.APIKey)
		return
	}
	if strings.TrimSpace(credential.AccessToken) != "" {
		header.Set("Authorization", "Bearer "+credential.AccessToken)
	}
}

// isHopByHopHeader checks if a header name (case-insensitive) is a hop-by-hop header.
// The input is normalized to lowercase before checking.
func isHopByHopHeader(k string) bool {
	switch strings.ToLower(k) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}

func generateRequestID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return "req_" + hex.EncodeToString(buf)
}

func mapForwardError(err *proxy.ForwardError) *report.ErrorPayload {
	if err == nil {
		return nil
	}
	return &report.ErrorPayload{Message: err.Message, Phase: err.Phase}
}

type staticResolver struct {
	result proxy.ResolveResult
}

func (s staticResolver) Resolve(_ context.Context, _ string) (proxy.ResolveResult, error) {
	return s.result, nil
}
