import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export const SQLITE_MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    path: path.join(MIGRATIONS_DIR, '001_initial_schema.sql'),
    requiredIndexes: [
      {
        name: 'idx_entities_collection',
        sql: 'CREATE INDEX IF NOT EXISTS idx_entities_collection ON entities(collection)',
      },
      {
        name: 'idx_entities_updated_at',
        sql: 'CREATE INDEX IF NOT EXISTS idx_entities_updated_at ON entities(updated_at)',
      },
      {
        name: 'idx_hot_state_provider',
        sql: 'CREATE INDEX IF NOT EXISTS idx_hot_state_provider ON hot_state(provider)',
      },
      {
        name: 'idx_hot_state_updated_at',
        sql: 'CREATE INDEX IF NOT EXISTS idx_hot_state_updated_at ON hot_state(updated_at)',
      },
    ],
  },
];

export const LATEST_SQLITE_SCHEMA_VERSION = SQLITE_MIGRATIONS.reduce(
  (latest, migration) => Math.max(latest, Number(migration?.version) || 0),
  0
);

export function readSqliteMigrationSql(migration) {
  return fs.readFileSync(migration.path, 'utf-8');
}
