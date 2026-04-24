package cache

import (
	"testing"
	"time"

	"go-proxy/internal/resolve"
)

func TestResolveCacheHonorsTTL(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	clock := func() time.Time { return now }

	c := NewResolveCache(2*time.Second, clock)
	resp := resolve.Response{Provider: "openai", Model: "gpt-4.1"}
	c.Set("sk-test", resp)

	got, ok := c.Get("sk-test")
	if !ok {
		t.Fatalf("expected cache hit before TTL")
	}
	if got.Provider != "openai" {
		t.Fatalf("expected provider openai, got %q", got.Provider)
	}

	now = now.Add(3 * time.Second)
	if _, ok := c.Get("sk-test"); ok {
		t.Fatalf("expected cache miss after TTL expiry")
	}
}
