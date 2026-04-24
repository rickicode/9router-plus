package credentials

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestReadByConnectionID_ApiKeyConnection(t *testing.T) {
	path := filepath.Join("..", "testdata", "credentials", "sample.json")

	reader := NewReader(path)
	cred, err := reader.ReadByConnectionID("conn-apikey-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if cred.ConnectionID != "conn-apikey-1" {
		t.Fatalf("expected connection id conn-apikey-1, got %q", cred.ConnectionID)
	}
	if cred.Provider != "openai" {
		t.Fatalf("expected provider openai, got %q", cred.Provider)
	}
	if cred.APIKey != "sk-test-openai" {
		t.Fatalf("expected api key sk-test-openai, got %q", cred.APIKey)
	}
}

func TestReadByConnectionID_OAuthConnection(t *testing.T) {
	path := filepath.Join("..", "testdata", "credentials", "sample.json")

	reader := NewReader(path)
	cred, err := reader.ReadByConnectionID("conn-oauth-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if cred.ConnectionID != "conn-oauth-1" {
		t.Fatalf("expected connection id conn-oauth-1, got %q", cred.ConnectionID)
	}
	if cred.Provider != "claude" {
		t.Fatalf("expected provider claude, got %q", cred.Provider)
	}
	if cred.AccessToken != "oauth-access-token" {
		t.Fatalf("expected access token oauth-access-token, got %q", cred.AccessToken)
	}
}

func TestReadByConnectionID_ConcurrentAccessRefreshesOnFileChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "db.json")
	writeFixture := func(apiKey string) {
		t.Helper()
		data := []byte(`{"providerConnections":[{"id":"conn-apikey-1","provider":"openai","authType":"apiKey","apiKey":"` + apiKey + `"}]}`)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
	}

	writeFixture("sk-before")
	reader := NewReader(path)

	var wg sync.WaitGroup
	errCh := make(chan error, 32)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cred, err := reader.ReadByConnectionID("conn-apikey-1")
			if err != nil {
				errCh <- err
				return
			}
			if cred.APIKey != "sk-before" {
				errCh <- ErrConnectionNotFound
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatalf("unexpected concurrent read error: %v", err)
		}
	}

	writeFixture("sk-after")
	cred, err := reader.ReadByConnectionID("conn-apikey-1")
	if err != nil {
		t.Fatalf("expected refreshed read to succeed, got %v", err)
	}
	if cred.APIKey != "sk-after" {
		t.Fatalf("expected refreshed API key sk-after, got %q", cred.APIKey)
	}
}
