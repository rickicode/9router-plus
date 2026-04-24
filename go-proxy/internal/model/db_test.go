package model

import "testing"

func TestStore_LoadFileAndExposeLookups(t *testing.T) {
	store, err := LoadStore("../testdata/model/db_phase1.json")
	if err != nil {
		t.Fatalf("expected store to load: %v", err)
	}

	if got := store.ModelAliases()["fast"]; got.RawString != "openai/gpt-4.1-mini" {
		t.Fatalf("unexpected fast alias: %#v", got)
	}

	if got := store.ModelAliases()["smart"]; got.Provider != "cc" || got.Model != "claude-sonnet-4-20250514" {
		t.Fatalf("unexpected smart alias: %#v", got)
	}

	combo, ok := store.ComboByName("writer-pack")
	if !ok || len(combo.Models) != 2 {
		t.Fatalf("unexpected combo: %#v", combo)
	}

	if combo.Models[0] != "openai/gpt-4.1" || combo.Models[1] != "claude/claude-sonnet-4-20250514" {
		t.Fatalf("unexpected combo models: %#v", combo.Models)
	}

	openaiNodes := store.ProviderNodesByType("openai-compatible")
	if len(openaiNodes) != 2 {
		t.Fatalf("expected 2 openai-compatible nodes, got %d", len(openaiNodes))
	}

	node, ok := store.ProviderNodeByPrefix("acmp", "anthropic-compatible")
	if !ok || node.ID != "anthropic-compatible-local" {
		t.Fatalf("unexpected anthropic-compatible node: %#v", node)
	}
}
