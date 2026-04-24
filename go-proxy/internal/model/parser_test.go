package model

import "testing"

func TestParse_EmptyString(t *testing.T) {
	got := Parse("")
	if got != (ParsedModel{Provider: "", Model: "", IsAlias: false, ProviderAlias: ""}) {
		t.Fatalf("unexpected parsed model: %#v", got)
	}
}

func TestParse_ProviderSlashModel(t *testing.T) {
	got := Parse("openai/gpt-4.1")
	if got.Provider != "openai" || got.Model != "gpt-4.1" || got.IsAlias {
		t.Fatalf("unexpected parsed model: %#v", got)
	}
}

func TestParse_AliasSlashModel_ResolvesProviderAlias(t *testing.T) {
	got := Parse("cc/claude-sonnet-4")
	if got.Provider != "claude" || got.Model != "claude-sonnet-4" || got.ProviderAlias != "cc" {
		t.Fatalf("unexpected parsed model: %#v", got)
	}
}

func TestParse_SplitsOnFirstSlashOnly(t *testing.T) {
	got := Parse("openai/gpt/custom")
	if got.Provider != "openai" || got.Model != "gpt/custom" {
		t.Fatalf("unexpected parsed model: %#v", got)
	}
}

func TestParse_SlashlessValueBecomesAliasCandidate(t *testing.T) {
	got := Parse("fast")
	if !got.IsAlias || got.Model != "fast" || got.Provider != "" {
		t.Fatalf("unexpected parsed model: %#v", got)
	}
}

func TestResolveProviderAlias_KnownAndUnknown(t *testing.T) {
	if got := ResolveProviderAlias("cc"); got != "claude" {
		t.Fatalf("expected claude, got %q", got)
	}
	if got := ResolveProviderAlias("openai"); got != "openai" {
		t.Fatalf("expected openai passthrough, got %q", got)
	}
}
