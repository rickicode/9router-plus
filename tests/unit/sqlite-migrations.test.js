import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tempDirs = [];
let sqliteHelpersModule = null;
let sqliteMigrationsModule = null;

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '9router-sqlite-migrations-'));
  tempDirs.push(dir);
  return dir;
}

async function loadModules() {
  vi.resetModules();
  const [sqliteHelpers, sqliteMigrations] = await Promise.all([
    import('../../src/lib/sqliteHelpers.js'),
    import('../../src/lib/sqliteMigrations.js'),
  ]);
  sqliteHelpersModule = sqliteHelpers;
  sqliteMigrationsModule = sqliteMigrations;
  return { sqliteHelpers, sqliteMigrations };
}

beforeEach(async () => {
  process.env.DATA_DIR = await createTempDataDir();
});

afterEach(async () => {
  sqliteHelpersModule?.closeSqliteDb?.();
  sqliteHelpersModule = null;
  sqliteMigrationsModule = null;
  delete process.env.DATA_DIR;
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('sqlite migration bootstrap', () => {
  it('bootstraps an empty database to the latest schema version via SQLITE_MIGRATIONS', async () => {
    const { sqliteHelpers, sqliteMigrations } = await loadModules();

    const db = sqliteHelpers.getSqliteDb();
    sqliteHelpers.ensureSchema(db);

    const schemaVersions = db.prepare('SELECT version FROM schema_version ORDER BY version ASC').all();
    const latestAppliedVersion = schemaVersions.at(-1)?.version ?? 0;
    const entitiesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'entities'").get();

    expect(sqliteMigrations.SQLITE_MIGRATIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: expect.any(Number),
          path: expect.stringContaining('001_initial_schema.sql'),
        }),
      ])
    );
    expect(schemaVersions.length).toBeGreaterThan(0);
    expect(latestAppliedVersion).toBeGreaterThanOrEqual(1);
    expect(latestAppliedVersion).toBe(sqliteMigrations.LATEST_SQLITE_SCHEMA_VERSION);
    expect(entitiesTable?.name).toBe('entities');
  });

  it('repairs missing required indexes for an already-versioned database', async () => {
    const { sqliteHelpers, sqliteMigrations } = await loadModules();
    const readSqliteMigrationSqlSpy = vi.spyOn(sqliteMigrations, 'readSqliteMigrationSql');

    const db = sqliteHelpers.getSqliteDb();
    sqliteHelpers.ensureSchema(db);
    expect(readSqliteMigrationSqlSpy).toHaveBeenCalledTimes(1);
    readSqliteMigrationSqlSpy.mockClear();

    const initialSchemaVersionCount = db.prepare('SELECT COUNT(*) AS count FROM schema_version').get().count;

    db.exec('DROP INDEX IF EXISTS idx_entities_collection');
    db.exec('DROP INDEX IF EXISTS idx_hot_state_provider');

    const missingBeforeRepair = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_entities_collection', 'idx_hot_state_provider') ORDER BY name ASC"
    ).all();

    expect(missingBeforeRepair).toEqual([]);

    sqliteHelpers.ensureSchema(db);

    const repairedIndexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_entities_collection', 'idx_hot_state_provider') ORDER BY name ASC"
    ).all();
    const schemaVersions = db.prepare('SELECT version FROM schema_version ORDER BY version ASC').all();

    expect(repairedIndexes.map((row) => row.name)).toEqual([
      'idx_entities_collection',
      'idx_hot_state_provider',
    ]);
    expect(schemaVersions).toEqual([
      { version: sqliteMigrations.LATEST_SQLITE_SCHEMA_VERSION },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_version').get().count).toBe(initialSchemaVersionCount);
    expect(readSqliteMigrationSqlSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when schema is already at the latest version with required indexes present', async () => {
    const { sqliteHelpers, sqliteMigrations } = await loadModules();
    const readSqliteMigrationSqlSpy = vi.spyOn(sqliteMigrations, 'readSqliteMigrationSql');

    const db = sqliteHelpers.getSqliteDb();
    sqliteHelpers.ensureSchema(db);

    const beforeVersions = db.prepare('SELECT version, applied_at FROM schema_version ORDER BY version ASC').all();
    const beforeIndexNames = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_entities_collection', 'idx_entities_updated_at', 'idx_hot_state_provider', 'idx_hot_state_updated_at') ORDER BY name ASC"
    ).all();

    expect(beforeVersions).toEqual([
      {
        version: sqliteMigrations.LATEST_SQLITE_SCHEMA_VERSION,
        applied_at: expect.any(Number),
      },
    ]);
    expect(beforeIndexNames.map((row) => row.name)).toEqual([
      'idx_entities_collection',
      'idx_entities_updated_at',
      'idx_hot_state_provider',
      'idx_hot_state_updated_at',
    ]);

    readSqliteMigrationSqlSpy.mockClear();

    sqliteHelpers.ensureSchema(db);

    const afterVersions = db.prepare('SELECT version, applied_at FROM schema_version ORDER BY version ASC').all();
    const afterIndexNames = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_entities_collection', 'idx_entities_updated_at', 'idx_hot_state_provider', 'idx_hot_state_updated_at') ORDER BY name ASC"
    ).all();

    expect(afterVersions).toEqual(beforeVersions);
    expect(afterIndexNames).toEqual(beforeIndexNames);
    expect(readSqliteMigrationSqlSpy).not.toHaveBeenCalled();
  });
});
