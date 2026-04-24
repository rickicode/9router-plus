package credentials

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

var ErrConnectionNotFound = errors.New("connection not found")

// Credential is the minimal credential payload read from 9router's shared db.json shape.
type Credential struct {
	ConnectionID string
	Provider     string
	AuthType     string
	APIKey       string
	AccessToken  string
	RefreshToken string
}

// Reader loads credentials from the existing 9router local DB JSON file.
type Reader struct {
	filePath string
	mu       sync.RWMutex
	cache    DBShape
	modTime  time.Time
}

func NewReader(filePath string) *Reader {
	return &Reader{filePath: filePath}
}

// DBShape represents the database structure (public for stats)
type DBShape struct {
	ProviderConnections []ProviderConnection `json:"providerConnections"`
}

// ProviderConnection represents a single provider connection (public for stats)
type ProviderConnection struct {
	ID           string `json:"id"`
	Provider     string `json:"provider"`
	AuthType     string `json:"authType"`
	APIKey       string `json:"apiKey"`
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
}

func (r *Reader) ReadByConnectionID(connectionID string) (Credential, error) {
	db, err := r.LoadDB()
	if err != nil {
		return Credential{}, err
	}

	for _, c := range db.ProviderConnections {
		if c.ID != connectionID {
			continue
		}
		return Credential{
			ConnectionID: c.ID,
			Provider:     c.Provider,
			AuthType:     c.AuthType,
			APIKey:       c.APIKey,
			AccessToken:  c.AccessToken,
			RefreshToken: c.RefreshToken,
		}, nil
	}

	return Credential{}, fmt.Errorf("%w: %s", ErrConnectionNotFound, connectionID)
}

// LoadDB loads and returns the database shape (public for stats)
func (r *Reader) LoadDB() (DBShape, error) {
	info, err := os.Stat(r.filePath)
	if err != nil {
		return DBShape{}, fmt.Errorf("stat credentials file: %w", err)
	}

	r.mu.RLock()
	if !r.modTime.IsZero() && info.ModTime().Equal(r.modTime) {
		cached := r.cache
		r.mu.RUnlock()
		return cached, nil
	}
	r.mu.RUnlock()

	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.modTime.IsZero() && info.ModTime().Equal(r.modTime) {
		return r.cache, nil
	}

	content, err := os.ReadFile(r.filePath)
	if err != nil {
		return DBShape{}, fmt.Errorf("read credentials file: %w", err)
	}

	var db DBShape
	if err := json.Unmarshal(content, &db); err != nil {
		return DBShape{}, fmt.Errorf("decode credentials file: %w", err)
	}

	r.cache = db
	r.modTime = info.ModTime()
	return db, nil
}
