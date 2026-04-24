package model

import "testing"

func mustLoadStore(t *testing.T) *Store {
	t.Helper()

	store, err := LoadStore("../testdata/model/db_phase1.json")
	if err != nil {
		t.Fatalf("expected store to load: %v", err)
	}

	return store
}

func TestResolveModel_DirectProviderModelPassesThrough(t *testing.T) {
	store := mustLoadStore(t)
	got, err := ResolveModel("openai/gpt-4.1", store)
	if err != nil {
		t.Fatalf("expected no error: %v", err)
	}
	if got != (Resolution{Provider: "openai", Model: "gpt-4.1"}) {
		t.Fatalf("unexpected resolution: %#v", got)
	}
}

func TestResolveModel_ComboNameWinsBeforeAliasFallback(t *testing.T) {
	store := mustLoadStore(t)
	got, err := ResolveModel("writer-pack", store)
	if err != nil {
		t.Fatalf("expected no error: %v", err)
	}
	if !got.IsCombo || got.Provider != "" || got.Model != "writer-pack" {
		t.Fatalf("unexpected combo resolution: %#v", got)
	}
}

func TestResolveModel_AliasStringTarget(t *testing.T) {
	store := mustLoadStore(t)
	got, err := ResolveModel("fast", store)
	if err != nil {
		t.Fatalf("expected no error: %v", err)
	}
	if got != (Resolution{Provider: "openai", Model: "gpt-4.1-mini"}) {
		t.Fatalf("unexpected resolution: %#v", got)
	}
}

func TestResolveModel_AliasObjectTarget_ResolvesProviderAlias(t *testing.T) {
	store := mustLoadStore(t)
	got, err := ResolveModel("smart", store)
	if err != nil {
		t.Fatalf("expected no error: %v", err)
	}
	if got != (Resolution{Provider: "claude", Model: "claude-sonnet-4-20250514"}) {
		t.Fatalf("unexpected resolution: %#v", got)
	}
}

func TestResolveModel_InferProviderWhenAliasMissing(t *testing.T) {
	store := mustLoadStore(t)
	cases := map[string]string{
		"claude-3-7-sonnet": "anthropic",
		"gemini-2.5-pro":    "gemini",
		"gpt-4.1":           "openai",
		"o3-mini":           "openai",
		"deepseek-r1":       "deepseek",
		"unknown-model":     "openai",
	}
	for input, wantProvider := range cases {
		got, err := ResolveModel(input, store)
		if err != nil {
			t.Fatalf("input %s: unexpected error: %v", input, err)
		}
		if got.Provider != wantProvider || got.Model != input {
			t.Fatalf("input %s: unexpected resolution: %#v", input, got)
		}
	}
}

func TestResolveModel_CustomProviderPrefixMapsToNodeID(t *testing.T) {
	store := mustLoadStore(t)
	got, err := ResolveModel("oaic/gpt-4.1", store)
	if err != nil {
		t.Fatalf("expected no error: %v", err)
	}
	if got != (Resolution{Provider: "openai-compatible-local", Model: "gpt-4.1"}) {
		t.Fatalf("unexpected resolution: %#v", got)
	}
}

func TestResolveModel_CustomAnthropicPrefixMapsToNodeID(t *testing.T) {
	store := mustLoadStore(t)
	got, err := ResolveModel("acmp/claude-sonnet-4", store)
	if err != nil {
		t.Fatalf("expected no error: %v", err)
	}
	if got != (Resolution{Provider: "anthropic-compatible-local", Model: "claude-sonnet-4"}) {
		t.Fatalf("unexpected resolution: %#v", got)
	}
}

func TestInferProvider(t *testing.T) {
	cases := map[string]string{
		"claude-3-7-sonnet": "anthropic",
		"gemini-2.5-pro":    "gemini",
		"gpt-4.1":           "openai",
		"o3-mini":           "openai",
		"deepseek-r1":       "deepseek",
		"unknown-model":     "openai",
	}

	for input, want := range cases {
		if got := InferProvider(input); got != want {
			t.Fatalf("input %s: expected %s, got %s", input, want, got)
		}
	}
}

func TestResolveModel_AliasResolutionDepthExceeded(t *testing.T) {
	store := &Store{
		aliases: map[string]Alias{
			"loop-0":  {RawString: "loop-1"},
			"loop-1":  {RawString: "loop-2"},
			"loop-2":  {RawString: "loop-3"},
			"loop-3":  {RawString: "loop-4"},
			"loop-4":  {RawString: "loop-5"},
			"loop-5":  {RawString: "loop-6"},
			"loop-6":  {RawString: "loop-7"},
			"loop-7":  {RawString: "loop-8"},
			"loop-8":  {RawString: "loop-9"},
			"loop-9":  {RawString: "loop-10"},
			"loop-10": {RawString: "loop-11"},
			"loop-11": {RawString: "loop-0"},
		},
	}

	if _, err := ResolveModel("loop-0", store); err == nil {
		t.Fatal("expected alias depth limit error")
	}
}

func TestResolveModel_NilStoreErrors(t *testing.T) {
	if _, err := ResolveModel("openai/gpt-4.1", nil); err == nil {
		t.Fatal("expected error for nil store")
	}
}
