package provider

import (
	"net/http"

	"go-proxy/internal/credentials"
)

type BuildOptions struct {
	BaseURL        string
	BaseURLIndex   int
	QwenResourceURL string
	RegistryHeaders http.Header
	Credential      credentials.Credential
	CopilotToken    string
	RequestID       string
}
