-- Granular entity storage for collections
CREATE TABLE entities (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (collection, id)
);

CREATE INDEX idx_entities_collection ON entities(collection);
CREATE INDEX idx_entities_updated_at ON entities(updated_at);

-- Settings and singleton data
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Migration tracking
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

INSERT INTO schema_version (version) VALUES (1);
