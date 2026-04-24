package provider

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

func BuildURL(provider, model string, stream bool, options BuildOptions) (string, error) {
	if isOpenAICompatible(provider) {
		baseURL := firstNonEmpty(options.BaseURL, openAICompatibleBaseURL)
		if getOpenAICompatibleType(provider) == "responses" {
			return trimTrailingSlash(baseURL) + "/responses", nil
		}
		return trimTrailingSlash(baseURL) + "/chat/completions", nil
	}

	if isAnthropicCompatible(provider) {
		baseURL := firstNonEmpty(options.BaseURL, anthropicCompatibleBaseURL)
		return trimTrailingSlash(baseURL) + "/messages", nil
	}

	config, ok := GetConfig(provider)
	if !ok {
		if options.BaseURL != "" {
			return trimTrailingSlash(options.BaseURL), nil
		}
		return "", fmt.Errorf("unknown provider: %s", provider)
	}

	switch provider {
	case "claude", "glm", "kimi", "minimax":
		return trimTrailingSlash(config.BaseURL) + "?beta=true", nil
	case "gemini":
		action := "generateContent"
		if stream {
			action = "streamGenerateContent?alt=sse"
		}
		return trimTrailingSlash(config.BaseURL) + "/" + model + ":" + action, nil
	case "gemini-cli":
		action := "generateContent"
		if stream {
			action = "streamGenerateContent?alt=sse"
		}
		return trimTrailingSlash(config.BaseURL) + ":" + action, nil
	case "antigravity":
		baseURL := config.BaseURL
		if len(config.BaseURLs) == 0 && strings.TrimSpace(baseURL) == "" {
			return "", fmt.Errorf("provider %s has no base URL", provider)
		}
		if len(config.BaseURLs) > 0 {
			index := options.BaseURLIndex
			if index < 0 || index >= len(config.BaseURLs) {
				index = 0
			}
			baseURL = config.BaseURLs[index]
		}
		path := "/v1internal:generateContent"
		if stream {
			path = "/v1internal:streamGenerateContent?alt=sse"
		}
		return trimTrailingSlash(baseURL) + path, nil
	case "qwen":
		return buildQwenURL(config.BaseURL, options.QwenResourceURL)
	default:
		if config.BaseURL != "" {
			return trimTrailingSlash(config.BaseURL), nil
		}
		if options.BaseURL != "" {
			return trimTrailingSlash(options.BaseURL), nil
		}
		return "", fmt.Errorf("provider %s has no base URL", provider)
	}
}

func buildQwenURL(fallbackBaseURL, resourceURL string) (string, error) {
	baseURL := trimQwenPath(firstNonEmpty(resourceURL, fallbackBaseURL))
	if resourceURL != "" && !strings.HasPrefix(strings.TrimSpace(resourceURL), "http://") && !strings.HasPrefix(strings.TrimSpace(resourceURL), "https://") {
		baseURL = "https://" + strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(resourceURL), "/"), "/v1") + "/v1"
	}
	if err := validateQwenResourceURL(baseURL); err != nil {
		return "", err
	}
	return trimTrailingSlash(baseURL) + "/chat/completions", nil
}

func validateQwenResourceURL(raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return fmt.Errorf("invalid qwen resource URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("qwen resource URL must use http or https")
	}
	host := parsed.Hostname()
	if host == "" {
		return fmt.Errorf("qwen resource URL must include a host")
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil
	}
	if isPrivateOrLocalIP(ip) {
		return fmt.Errorf("qwen resource URL host is not allowed")
	}
	return nil
}

func isPrivateOrLocalIP(ip net.IP) bool {
	privateCIDRs := []string{
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"127.0.0.0/8",
		"169.254.0.0/16",
		"::1/128",
		"fe80::/10",
		"fc00::/7",
	}
	for _, cidr := range privateCIDRs {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func trimQwenPath(raw string) string {
	normalized := trimTrailingSlash(strings.TrimSpace(raw))
	normalized = strings.TrimSuffix(normalized, "/chat/completions")
	return normalized
}

func trimTrailingSlash(raw string) string {
	return strings.TrimRight(strings.TrimSpace(raw), "/")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
