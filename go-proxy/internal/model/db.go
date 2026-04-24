package model

import (
	"encoding/json"
	"os"
)

type Alias struct {
	RawString string `json:"-"`
	Provider  string `json:"provider"`
	Model     string `json:"model"`
}

func (a *Alias) UnmarshalJSON(data []byte) error {
	var raw string
	if err := json.Unmarshal(data, &raw); err == nil {
		a.RawString = raw
		a.Provider = ""
		a.Model = ""
		return nil
	}

	type alias Alias
	var decoded alias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}

	*a = Alias(decoded)
	a.RawString = ""
	return nil
}

type Combo struct {
	Name   string   `json:"name"`
	Models []string `json:"models"`
}

type ProviderNode struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Prefix  string `json:"prefix"`
	BaseURL string `json:"baseUrl"`
	APIType string `json:"apiType"`
}

type Store struct {
	aliases       map[string]Alias
	combos        []Combo
	providerNodes []ProviderNode
}

type storeFile struct {
	ModelAliases  map[string]Alias `json:"modelAliases"`
	Combos        []Combo          `json:"combos"`
	ProviderNodes []ProviderNode   `json:"providerNodes"`
}

func LoadStore(path string) (*Store, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var decoded storeFile
	if err := json.Unmarshal(data, &decoded); err != nil {
		return nil, err
	}

	return &Store{
		aliases:       decoded.ModelAliases,
		combos:        decoded.Combos,
		providerNodes: decoded.ProviderNodes,
	}, nil
}

func (s *Store) ModelAliases() map[string]Alias {
	if s == nil {
		return nil
	}

	return s.aliases
}

func (s *Store) ComboByName(name string) (Combo, bool) {
	if s == nil {
		return Combo{}, false
	}

	for _, combo := range s.combos {
		if combo.Name == name {
			return combo, true
		}
	}

	return Combo{}, false
}

func (s *Store) ProviderNodesByType(nodeType string) []ProviderNode {
	if s == nil {
		return nil
	}

	result := make([]ProviderNode, 0)
	for _, node := range s.providerNodes {
		if node.Type == nodeType {
			result = append(result, node)
		}
	}

	return result
}

func (s *Store) ProviderNodeByPrefix(prefix, nodeType string) (ProviderNode, bool) {
	if s == nil {
		return ProviderNode{}, false
	}

	for _, node := range s.providerNodes {
		if node.Prefix == prefix && node.Type == nodeType {
			return node, true
		}
	}

	return ProviderNode{}, false
}
