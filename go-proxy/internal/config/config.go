package config

import (
	"errors"
	"flag"
	"io"
	"os"
	"strconv"
	"strings"
)

// Config contains runtime settings for the Go proxy scaffold.
type Config struct {
	Host                     string
	Port                     int
	NineRouterBaseURL        string
	InternalResolveAuthToken string
	InternalReportAuthToken  string
	CredentialsFilePath      string
	HTTPTimeoutSeconds       int
}

// Default returns baseline config values for local development.
func Default() Config {
	host := strings.TrimSpace(os.Getenv("GO_PROXY_HOST"))
	if host == "" {
		host = "127.0.0.1"
	}

	port := 20138
	if raw := strings.TrimSpace(os.Getenv("GO_PROXY_PORT")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			port = parsed
		}
	}

	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("GO_PROXY_NINEROUTER_BASE_URL")), "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:20128"
	}

	resolveToken := strings.TrimSpace(os.Getenv("INTERNAL_PROXY_RESOLVE_TOKEN"))
	reportToken := strings.TrimSpace(os.Getenv("INTERNAL_PROXY_REPORT_TOKEN"))

	credentialsPath := strings.TrimSpace(os.Getenv("GO_PROXY_CREDENTIALS_FILE"))
	if credentialsPath == "" {
		if dataDir := strings.TrimSpace(os.Getenv("DATA_DIR")); dataDir != "" {
			credentialsPath = dataDir + "/db.json"
		}
	}
	if credentialsPath == "" {
		homeDir, err := os.UserHomeDir()
		if err == nil && strings.TrimSpace(homeDir) != "" {
			credentialsPath = homeDir + "/.9router/db.json"
		}
	}

	httpTimeoutSeconds := 30
	if raw := strings.TrimSpace(os.Getenv("GO_PROXY_HTTP_TIMEOUT_SECONDS")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			httpTimeoutSeconds = parsed
		}
	}

	return Config{
		Host:                     host,
		Port:                     port,
		NineRouterBaseURL:        baseURL,
		InternalResolveAuthToken: resolveToken,
		InternalReportAuthToken:  reportToken,
		CredentialsFilePath:      credentialsPath,
		HTTPTimeoutSeconds:       httpTimeoutSeconds,
	}
}

var ErrMissingInternalTokens = errors.New("missing required internal proxy tokens")

// LoadFromArgs builds config from defaults and explicit CLI args.
// CLI values are authoritative over environment-derived defaults.
func LoadFromArgs(args []string) (Config, error) {
	cfg := Default()

	fs := flag.NewFlagSet("go-proxy", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	fs.StringVar(&cfg.Host, "host", cfg.Host, "proxy host")
	fs.IntVar(&cfg.Port, "port", cfg.Port, "proxy port")
	fs.StringVar(&cfg.NineRouterBaseURL, "base-url", cfg.NineRouterBaseURL, "nine-router base URL")
	fs.StringVar(&cfg.InternalResolveAuthToken, "resolve-token", cfg.InternalResolveAuthToken, "internal resolve auth token")
	fs.StringVar(&cfg.InternalReportAuthToken, "report-token", cfg.InternalReportAuthToken, "internal report auth token")
	fs.StringVar(&cfg.CredentialsFilePath, "credentials-file", cfg.CredentialsFilePath, "credentials file path")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}

	cfg.Host = strings.TrimSpace(cfg.Host)
	if cfg.Host == "" {
		cfg.Host = "127.0.0.1"
	}
	if cfg.Port <= 0 {
		cfg.Port = 20138
	}
	cfg.NineRouterBaseURL = strings.TrimRight(strings.TrimSpace(cfg.NineRouterBaseURL), "/")
	if cfg.NineRouterBaseURL == "" {
		cfg.NineRouterBaseURL = "http://127.0.0.1:20128"
	}
	cfg.InternalResolveAuthToken = strings.TrimSpace(cfg.InternalResolveAuthToken)
	cfg.InternalReportAuthToken = strings.TrimSpace(cfg.InternalReportAuthToken)
	cfg.CredentialsFilePath = strings.TrimSpace(cfg.CredentialsFilePath)

	if cfg.InternalResolveAuthToken == "" || cfg.InternalReportAuthToken == "" {
		return Config{}, ErrMissingInternalTokens
	}

	return cfg, nil
}
