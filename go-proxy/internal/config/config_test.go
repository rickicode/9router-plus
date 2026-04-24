package config

import "testing"

func TestLoadFromArgs_BuildsConfigFromExplicitFlags(t *testing.T) {
	t.Setenv("GO_PROXY_HOST", "env-host")
	t.Setenv("GO_PROXY_PORT", "1111")
	t.Setenv("GO_PROXY_NINEROUTER_BASE_URL", "http://env.example/")
	t.Setenv("INTERNAL_PROXY_RESOLVE_TOKEN", "env-resolve")
	t.Setenv("INTERNAL_PROXY_REPORT_TOKEN", "env-report")
	t.Setenv("GO_PROXY_CREDENTIALS_FILE", "/env/db.json")

	cfg, err := LoadFromArgs([]string{
		"--host", "cli-host",
		"--port", "9090",
		"--base-url", "https://api.example.com/",
		"--resolve-token", "cli-resolve",
		"--report-token", "cli-report",
		"--credentials-file", "/tmp/cli-db.json",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if cfg.Host != "cli-host" {
		t.Fatalf("expected host from CLI, got %q", cfg.Host)
	}
	if cfg.Port != 9090 {
		t.Fatalf("expected port from CLI, got %d", cfg.Port)
	}
	if cfg.NineRouterBaseURL != "https://api.example.com" {
		t.Fatalf("expected base URL from CLI (trimmed), got %q", cfg.NineRouterBaseURL)
	}
	if cfg.InternalResolveAuthToken != "cli-resolve" {
		t.Fatalf("expected resolve token from CLI, got %q", cfg.InternalResolveAuthToken)
	}
	if cfg.InternalReportAuthToken != "cli-report" {
		t.Fatalf("expected report token from CLI, got %q", cfg.InternalReportAuthToken)
	}
	if cfg.CredentialsFilePath != "/tmp/cli-db.json" {
		t.Fatalf("expected credentials file from CLI, got %q", cfg.CredentialsFilePath)
	}
}

func TestLoadFromArgs_CLIValuesOverrideEnvDefaults(t *testing.T) {
	t.Setenv("GO_PROXY_HOST", "env-host")
	t.Setenv("GO_PROXY_PORT", "1111")
	t.Setenv("GO_PROXY_NINEROUTER_BASE_URL", "http://env.example/")
	t.Setenv("INTERNAL_PROXY_RESOLVE_TOKEN", "env-resolve")
	t.Setenv("INTERNAL_PROXY_REPORT_TOKEN", "env-report")
	t.Setenv("GO_PROXY_CREDENTIALS_FILE", "/env/db.json")

	cfg, err := LoadFromArgs([]string{
		"--host", "cli-host",
		"--port", "9090",
		"--base-url", "https://cli.example/",
		"--resolve-token", "cli-resolve",
		"--report-token", "cli-report",
		"--credentials-file", "/cli/db.json",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if cfg.Host != "cli-host" ||
		cfg.Port != 9090 ||
		cfg.NineRouterBaseURL != "https://cli.example" ||
		cfg.InternalResolveAuthToken != "cli-resolve" ||
		cfg.InternalReportAuthToken != "cli-report" ||
		cfg.CredentialsFilePath != "/cli/db.json" {
		t.Fatalf("expected CLI flags to override env defaults, got %+v", cfg)
	}
}

func TestLoadFromArgs_InvalidCLIFlagValueDoesNotFallbackToEnv(t *testing.T) {
	t.Setenv("GO_PROXY_PORT", "1111")
	t.Setenv("INTERNAL_PROXY_RESOLVE_TOKEN", "env-resolve")
	t.Setenv("INTERNAL_PROXY_REPORT_TOKEN", "env-report")

	_, err := LoadFromArgs([]string{"--port", "not-a-number"})
	if err == nil {
		t.Fatal("expected parse error for invalid --port value")
	}
}

func TestLoadFromArgs_RequiresInternalTokens(t *testing.T) {
	t.Setenv("INTERNAL_PROXY_RESOLVE_TOKEN", "")
	t.Setenv("INTERNAL_PROXY_REPORT_TOKEN", "")

	_, err := LoadFromArgs(nil)
	if err == nil {
		t.Fatal("expected error when internal tokens are missing")
	}
	if err != ErrMissingInternalTokens {
		t.Fatalf("expected ErrMissingInternalTokens, got %v", err)
	}
}

func TestLoadFromArgs_RequiresBothInternalTokens(t *testing.T) {
	t.Setenv("INTERNAL_PROXY_RESOLVE_TOKEN", "resolve-only")
	t.Setenv("INTERNAL_PROXY_REPORT_TOKEN", "")

	_, err := LoadFromArgs(nil)
	if err == nil {
		t.Fatal("expected error when report token is missing")
	}
	if err != ErrMissingInternalTokens {
		t.Fatalf("expected ErrMissingInternalTokens, got %v", err)
	}
}
