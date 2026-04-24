package translate

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func loadFixture(t *testing.T, name string) map[string]any {
	t.Helper()

	path := filepath.Join("..", "testdata", "translate", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}

	var fixture map[string]any
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("unmarshal fixture %s: %v", name, err)
	}

	return fixture
}

func assertEqualJSON(t *testing.T, expected, got any) {
	t.Helper()

	if expected == nil || got == nil {
		if !reflect.DeepEqual(expected, got) {
			t.Fatalf("json mismatch\nexpected: %#v\ngot: %#v", expected, got)
		}
		return
	}

	expectedBytes, err := json.Marshal(expected)
	if err != nil {
		t.Fatalf("marshal expected: %v", err)
	}
	gotBytes, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal got: %v", err)
	}

	var expectedNormalized any
	if err := json.Unmarshal(expectedBytes, &expectedNormalized); err != nil {
		t.Fatalf("normalize expected: %v", err)
	}
	var gotNormalized any
	if err := json.Unmarshal(gotBytes, &gotNormalized); err != nil {
		t.Fatalf("normalize got: %v", err)
	}

	if !reflect.DeepEqual(expectedNormalized, gotNormalized) {
		t.Fatalf("json mismatch\nexpected: %s\ngot: %s", string(expectedBytes), string(gotBytes))
	}
}

func TestParity_OpenAIToClaudeBasic(t *testing.T) {
	fixture := loadFixture(t, "parity_openai_claude_basic.json")
	input := fixture["input"].(map[string]any)
	expected := fixture["expected"].(map[string]any)

	got, err := TranslateRequest(FormatOpenAI, FormatClaude, input, TranslateOptions{
		Model:    "claude-sonnet-4",
		Stream:   true,
		Provider: "claude-cli",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	assertEqualJSON(t, expected["system"], got["system"])
	assertEqualJSON(t, expected["messages"], got["messages"])
	assertEqualJSON(t, expected["tools"], got["tools"])
}

func TestParity_OpenAIToGeminiWithTools(t *testing.T) {
	fixture := loadFixture(t, "parity_openai_gemini_tools.json")
	input := fixture["input"].(map[string]any)
	expected := fixture["expected"].(map[string]any)

	got, err := TranslateRequest(FormatOpenAI, FormatGemini, input, TranslateOptions{
		Model:  "gemini-2.5-pro",
		Stream: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	assertEqualJSON(t, expected["contents"], got["contents"])
	assertEqualJSON(t, expected["tools"], got["tools"])
}

func TestParity_ClaudeStreamingToOpenAI(t *testing.T) {
	fixture := loadFixture(t, "parity_claude_stream.json")
	chunks := fixture["chunks"].([]any)
	expectedOutputs := fixture["expected"].([]any)

	state := &StreamState{
		ToolCalls: make(map[int]*ToolCall),
	}

	for i, chunkData := range chunks {
		chunkBytes, _ := json.Marshal(chunkData)
		got, err := ClaudeToOpenAIChunk(chunkBytes, state)
		if err != nil {
			t.Fatalf("chunk %d: unexpected error: %v", i, err)
		}

		var gotParsed map[string]any
		if err := json.Unmarshal(got, &gotParsed); err != nil {
			t.Fatalf("chunk %d: unmarshal output: %v", i, err)
		}

		expected := expectedOutputs[i].(map[string]any)
		delete(gotParsed, "created")
		assertEqualJSON(t, expected, gotParsed)
	}
	if call := state.ToolCalls[2]; call == nil || call.Function["arguments"] != "{\"invoice_id\":\"inv_9001\",\"include_adjustments\":true}" {
		t.Fatalf("expected accumulated tool args, got %#v", state.ToolCalls[2])
	}
}

func TestParity_GeminiStreamingToOpenAI(t *testing.T) {
	fixture := loadFixture(t, "parity_gemini_stream.json")
	chunks := fixture["chunks"].([]any)
	expectedOutputs := fixture["expected"].([]any)

	state := &StreamState{
		MessageID: "msg_test",
		Model:     "gemini-2.5-pro",
		ToolCalls: make(map[int]*ToolCall),
	}

	for i, chunkData := range chunks {
		chunkStr := fmt.Sprintf("data: %s", chunkData)
		got, err := GeminiToOpenAIChunk([]byte(chunkStr), state)
		if err != nil {
			t.Fatalf("chunk %d: unexpected error: %v", i, err)
		}

		expected := expectedOutputs[i]
		if expected == nil {
			if got != nil {
				t.Fatalf("chunk %d: expected nil output, got %s", i, string(got))
			}
			continue
		}

		var gotParsed map[string]any
		if err := json.Unmarshal(got, &gotParsed); err != nil {
			t.Fatalf("chunk %d: unmarshal output: %v", i, err)
		}

		expectedMap := expected.(map[string]any)
		delete(gotParsed, "created")
		assertEqualJSON(t, expectedMap, gotParsed)
	}
	if state.UsageData == nil || state.UsageData.TotalTokens != 214 {
		t.Fatalf("expected usage metadata to be tracked, got %#v", state.UsageData)
	}
}
