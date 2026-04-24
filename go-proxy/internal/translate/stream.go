package translate

type ToolCall struct {
	Index     int                    `json:"index,omitempty"`
	ID        string                 `json:"id,omitempty"`
	Type      string                 `json:"type,omitempty"`
	Function  map[string]any         `json:"function,omitempty"`
	Arguments string                 `json:"-"`
}

type UsageData struct {
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
}

// StreamState stores incremental translation state for streaming adapters.
//
// Not thread-safe: callers must not read or mutate a StreamState from multiple
// goroutines concurrently without external synchronization.
type StreamState struct {
	MessageID            string
	Model                string
	ToolCallIndex        int
	ToolCalls            map[int]*ToolCall
	ToolNameMap          map[string]string
	ServerToolBlockIndex int
	ServerToolBlockActive bool
	TextBlockStarted     bool
	ThinkingBlockStarted bool
	InThinkingBlock      bool
	CurrentBlockIndex    int
	Usage                map[string]any
	UsageData            *UsageData
	FinishReason         string
	FinishReasonSent     bool
}
