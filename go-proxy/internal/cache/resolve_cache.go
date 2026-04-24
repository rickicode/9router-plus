package cache

import (
	"sync"
	"time"

	"go-proxy/internal/resolve"
)

type resolveEntry struct {
	value     resolve.Response
	expiresAt time.Time
}

// ResolveCache stores resolver responses by API key with TTL expiration.
type ResolveCache struct {
	ttl   time.Duration
	now   func() time.Time
	mu    sync.RWMutex
	items map[string]resolveEntry
}

// NewResolveCache creates a new ResolveCache.
func NewResolveCache(ttl time.Duration, now func() time.Time) *ResolveCache {
	if now == nil {
		now = time.Now
	}

	return &ResolveCache{
		ttl:   ttl,
		now:   now,
		items: make(map[string]resolveEntry),
	}
}

// Get returns a cached resolver response if present and not expired.
func (c *ResolveCache) Get(apiKey string) (resolve.Response, bool) {
	c.mu.RLock()
	entry, ok := c.items[apiKey]
	c.mu.RUnlock()
	if !ok {
		return resolve.Response{}, false
	}

	if !entry.expiresAt.After(c.now()) {
		c.mu.Lock()
		delete(c.items, apiKey)
		c.mu.Unlock()
		return resolve.Response{}, false
	}

	return entry.value, true
}

// Set stores a resolver response in cache using the configured TTL.
func (c *ResolveCache) Set(apiKey string, value resolve.Response) {
	c.mu.Lock()
	c.items[apiKey] = resolveEntry{
		value:     value,
		expiresAt: c.now().Add(c.ttl),
	}
	c.mu.Unlock()
}
