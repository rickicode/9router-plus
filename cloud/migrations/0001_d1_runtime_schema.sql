-- 9Router Cloud Worker D1 schema
-- Split publisher-owned sync data from cloud-owned mutable runtime state.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS worker_registry (
  worker_id TEXT PRIMARY KEY,
  runtime_url TEXT,
  cache_ttl_seconds INTEGER,
  registered_at TEXT,
  rotated_at TEXT,
  shared_secret_configured_at TEXT,
  runtime_refresh_requested_at TEXT,
  runtime_artifacts_loaded_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_sync (
  machine_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_type TEXT,
  name TEXT,
  priority INTEGER,
  global_priority INTEGER,
  default_model TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  expires_in INTEGER,
  token_type TEXT,
  scope TEXT,
  api_key TEXT,
  provider_specific_data TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  routing_status TEXT,
  health_status TEXT,
  quota_state TEXT,
  auth_state TEXT,
  reason_code TEXT,
  reason_detail TEXT,
  next_retry_at TEXT,
  reset_at TEXT,
  backoff_level INTEGER,
  last_checked_at TEXT,
  allow_auth_recovery INTEGER,
  usage_snapshot TEXT,
  version INTEGER,
  created_at TEXT,
  updated_at TEXT,
  sync_updated_at TEXT NOT NULL,
  PRIMARY KEY (machine_id, provider_id)
);

CREATE TABLE IF NOT EXISTS provider_runtime_state (
  machine_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  routing_status_override TEXT,
  health_status_override TEXT,
  quota_state_override TEXT,
  auth_state_override TEXT,
  reason_code_override TEXT,
  reason_detail_override TEXT,
  next_retry_at TEXT,
  reset_at TEXT,
  backoff_level INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  consecutive_use_count INTEGER NOT NULL DEFAULT 0,
  sticky_until TEXT,
  sticky_key_hash TEXT,
  runtime_updated_at TEXT NOT NULL,
  PRIMARY KEY (machine_id, provider_id),
  FOREIGN KEY (machine_id, provider_id) REFERENCES provider_sync(machine_id, provider_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_api_keys (
  machine_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_value TEXT NOT NULL,
  name TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT,
  sync_updated_at TEXT NOT NULL,
  PRIMARY KEY (machine_id, key_id)
);

CREATE TABLE IF NOT EXISTS runtime_model_aliases (
  machine_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  target TEXT NOT NULL,
  sync_updated_at TEXT NOT NULL,
  PRIMARY KEY (machine_id, alias)
);

CREATE TABLE IF NOT EXISTS runtime_combos (
  machine_id TEXT NOT NULL,
  combo_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sync_updated_at TEXT NOT NULL,
  PRIMARY KEY (machine_id, combo_id)
);

CREATE TABLE IF NOT EXISTS runtime_settings (
  machine_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  strategy TEXT,
  morph_json TEXT,
  sync_updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_sync_machine_provider ON provider_sync(machine_id, provider, is_active, priority);
CREATE INDEX IF NOT EXISTS idx_provider_runtime_retry ON provider_runtime_state(machine_id, next_retry_at, reset_at);
CREATE INDEX IF NOT EXISTS idx_runtime_api_keys_machine_active ON runtime_api_keys(machine_id, is_active);
