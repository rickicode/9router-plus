import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { DATA_DIR } from './dataDir.js';
import { HOT_STATE_KEYS } from './hotStateKeys.js';
import { readSqliteMigrationSql, SQLITE_MIGRATIONS } from './sqliteMigrations.js';

const nodeRequire = createRequire(import.meta.url);

let Database = null;

function loadDatabaseDriver() {
  if (Database) return Database;
  if (typeof Bun !== 'undefined') {
    Database = BunSQLiteDatabase;
    return Database;
  }
  Database = NodeSQLiteDatabase;
  return Database;
}

function NodeSQLiteDatabase(filePath) {
  const BetterSqliteDatabase = nodeRequire('better-sqlite3');
  return new BetterSqliteDatabase(filePath);
}

class BunSQLiteStatement {
  constructor(statement) {
    this.statement = statement;
  }

  run(...args) {
    return this.statement.run(...args);
  }

  get(...args) {
    return this.statement.get(...args);
  }

  all(...args) {
    return this.statement.all(...args);
  }
}

class BunSQLiteAdapter {
  constructor(filePath) {
    const bunSqlite = nodeRequire('bun:sqlite');
    const BunBuiltinDatabase = bunSqlite?.Database;
    if (!BunBuiltinDatabase) {
      throw new Error('bun:sqlite is required when running SQLite storage under Bun');
    }
    this.db = new BunBuiltinDatabase(filePath);
  }

  pragma(sql, options = {}) {
    const rows = this.db.query(`PRAGMA ${sql}`).all();
    if (options?.simple) {
      const first = rows?.[0];
      if (!first) return undefined;
      return Object.values(first)[0];
    }
    return rows;
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    return new BunSQLiteStatement(this.db.query(sql));
  }

  transaction(callback) {
    return (...args) => this.db.transaction(() => callback(...args))();
  }

  close() {
    return this.db.close();
  }
}

function BunSQLiteDatabase(filePath) {
  return new BunSQLiteAdapter(filePath);
}

const DB_SQLITE_FILE = path.join(DATA_DIR, 'db.sqlite');

let sqliteDb = null;
const DEFAULT_SQLITE_MMAP_SIZE = 1024 * 1024 * 1024;

export function configureSqlitePragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  db.pragma('temp_store = MEMORY');
  db.pragma(`mmap_size = ${DEFAULT_SQLITE_MMAP_SIZE}`);
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
}

function listMissingMigrationIndexes(db, migration) {
  const requiredIndexes = normalizeRequiredIndexes(migration);

  if (requiredIndexes.length === 0) {
    return [];
  }

  const existingIndexes = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IS NOT NULL")
      .all()
      .map((row) => row?.name)
      .filter((name) => typeof name === 'string' && name.length > 0)
  );

  return requiredIndexes
    .map((indexDefinition) => indexDefinition.name)
    .filter((indexName) => !existingIndexes.has(indexName));
}

function normalizeRequiredIndexes(migration) {
  if (!Array.isArray(migration?.requiredIndexes)) {
    return [];
  }

  return migration.requiredIndexes
    .map((indexDefinition) => {
      if (typeof indexDefinition === 'string' && indexDefinition.length > 0) {
        return { name: indexDefinition, sql: null };
      }
      if (
        indexDefinition &&
        typeof indexDefinition === 'object' &&
        typeof indexDefinition.name === 'string' &&
        indexDefinition.name.length > 0
      ) {
        return {
          name: indexDefinition.name,
          sql: typeof indexDefinition.sql === 'string' && indexDefinition.sql.trim().length > 0
            ? indexDefinition.sql.trim()
            : null,
        };
      }
      return null;
    })
    .filter(Boolean);
}

function repairMigrationIndexes(db, migration, missingIndexes) {
  if (!Array.isArray(missingIndexes) || missingIndexes.length === 0) {
    return;
  }

  const requiredIndexesByName = new Map(
    normalizeRequiredIndexes(migration).map((indexDefinition) => [indexDefinition.name, indexDefinition])
  );

  const repairIndexes = db.transaction(() => {
    for (const indexName of missingIndexes) {
      const indexDefinition = requiredIndexesByName.get(indexName);
      if (!indexDefinition?.sql) {
        throw new Error(
          `SQLite migration ${migration?.version} is missing repair SQL for required index ${indexName}`
        );
      }
      db.exec(indexDefinition.sql);
    }
  });

  repairIndexes();
}

function logSafeError(message, error) {
  console.error(message, {
    name: error?.name,
    code: error?.code,
    message: error?.message,
  });
}

function assertNonEmptyString(value, name) {
  if (!value || typeof value !== 'string') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function sanitizeHotState(state = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(state).filter(([key, value]) => {
      if (value === undefined) return false;
      return HOT_STATE_KEYS.has(key) || key.startsWith('modelLock_');
    })
  );
}

function parseHotStateRow(row) {
  if (!row?.value) return null;

  try {
    const parsed = JSON.parse(row.value);
    const sanitized = sanitizeHotState(parsed);
    return Object.keys(sanitized).length > 0 ? sanitized : null;
  } catch {
    return null;
  }
}

function loadHotStateRows(provider, connectionIds = null) {
  const db = getSqliteDb();
  ensureSchema(db);

  if (Array.isArray(connectionIds)) {
    const validIds = connectionIds.filter((connectionId) => typeof connectionId === 'string' && connectionId.length > 0);
    if (validIds.length === 0) return [];
    const placeholders = validIds.map(() => '?').join(', ');
    return db.prepare(
      `SELECT connection_id, value FROM hot_state WHERE provider = ? AND connection_id IN (${placeholders})`
    ).all(provider, ...validIds);
  }

  return db.prepare('SELECT connection_id, value FROM hot_state WHERE provider = ?').all(provider);
}

export function getSqliteDb() {
  if (sqliteDb) return sqliteDb;

  const Driver = loadDatabaseDriver();
  const db = new Driver(DB_SQLITE_FILE);

  configureSqlitePragmas(db);

  sqliteDb = db;
  return sqliteDb;
}

export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `);

  const appliedVersions = new Set(
    db.prepare('SELECT version FROM schema_version ORDER BY version ASC').all().map((row) => Number(row.version))
  );

  for (const migration of SQLITE_MIGRATIONS) {
    const version = Number(migration?.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`Invalid SQLite migration version: ${migration?.version}`);
    }

    const missingIndexes = listMissingMigrationIndexes(db, migration);
    if (appliedVersions.has(version)) {
      repairMigrationIndexes(db, migration, missingIndexes);
      continue;
    }

    const applyMigration = db.transaction(() => {
      db.exec(readSqliteMigrationSql(migration));
      db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    });

    applyMigration();
    appliedVersions.add(version);
  }
}

function removeSqliteArtifacts() {
  for (const file of [DB_SQLITE_FILE, `${DB_SQLITE_FILE}-wal`, `${DB_SQLITE_FILE}-shm`]) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

const COLLECTION_KEYS = ['providerConnections', 'providerNodes', 'proxyPools', 'combos', 'apiKeys', 'customModels'];
const SINGLETON_KEYS = ['settings', 'modelAliases', 'pricing', 'mitmAlias', 'opencodeSync', 'runtimeConfig', 'tunnelState'];
const HOT_STATE_METADATA_KEY = 'hotStateMetadata';

function validateCollectionRecords(data, collectionName) {
  const records = Array.isArray(data?.[collectionName]) ? data[collectionName] : [];

  for (const [index, item] of records.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !item.id || typeof item.id !== 'string') {
      throw new Error(`Invalid ${collectionName}[${index}]: missing id`);
    }
  }
}

function validateSqliteImportCollections(data) {
  for (const collectionName of COLLECTION_KEYS) {
    validateCollectionRecords(data, collectionName);
  }
}

function loadHotStateMetadataMap() {
  const db = getSqliteDb();
  ensureSchema(db);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(HOT_STATE_METADATA_KEY);
  if (!row?.value) return {};

  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveHotStateMetadataMap(metadata) {
  const db = getSqliteDb();
  ensureSchema(db);
  db.prepare(
    'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
  ).run(HOT_STATE_METADATA_KEY, JSON.stringify(metadata || {}), Date.now());
}

function nextHotStateMetadataEntry(previous = null) {
  return {
    version: Math.max(0, Number(previous?.version) || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
}

function bumpProviderHotStateMetadata(provider, metadata = null) {
  assertNonEmptyString(provider, 'provider');
  const allMetadata = loadHotStateMetadataMap();
  const nextMetadata = metadata || nextHotStateMetadataEntry(allMetadata[provider]);
  allMetadata[provider] = nextMetadata;
  saveHotStateMetadataMap(allMetadata);
  return nextMetadata;
}

export function markProviderHotStateInvalidated(provider) {
  return bumpProviderHotStateMetadata(provider);
}

export function loadProviderHotStateMetadata(provider) {
  assertNonEmptyString(provider, 'provider');
  const metadata = loadHotStateMetadataMap()[provider];
  if (!metadata || typeof metadata !== 'object') return null;
  return {
    version: Math.max(0, Number(metadata.version) || 0),
    updatedAt: metadata.updatedAt || null,
  };
}

export function closeSqliteDb() {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
}

const DB_JSON_FILE = path.join(DATA_DIR, 'db.json');

export function migrateFromJSON() {
  const options = arguments[0] && typeof arguments[0] === 'object' ? arguments[0] : {};
  const preserveJson = options.preserveJson !== false;

  // Check if migration needed
  const jsonExists = fs.existsSync(DB_JSON_FILE);
  const sqliteExists = fs.existsSync(DB_SQLITE_FILE);
  
  if (!jsonExists || sqliteExists) {
    return { migrated: false };
  }
  
  console.log('[DB] Starting migration from JSON to SQLite...');
  
  try {
    // Read JSON data
    const jsonData = JSON.parse(fs.readFileSync(DB_JSON_FILE, 'utf-8'));
    
    validateSqliteImportCollections(jsonData);

    const db = getSqliteDb();
    ensureSchema(db);
    
    // Populate data in transaction
    const transaction = db.transaction(() => {
      // Migrate collections
      const entityStmt = db.prepare(
        'INSERT INTO entities (collection, id, value, updated_at) VALUES (?, ?, ?, ?)'
      );
      
      for (const collection of COLLECTION_KEYS) {
        const items = jsonData[collection] || [];
        for (const item of items) {
          if (item.id) {
            entityStmt.run(collection, item.id, JSON.stringify(item), Date.now());
          }
        }
      }
      
      // Migrate singletons
      const settingStmt = db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
      );
      
      for (const key of SINGLETON_KEYS) {
        if (jsonData[key] !== undefined) {
          settingStmt.run(key, JSON.stringify(jsonData[key]), Date.now());
        }
      }
    });
    
    transaction();
    
    // Verify migration
    for (const col of COLLECTION_KEYS) {
      const originalCount = (jsonData[col] || []).length;
      const migratedCount = db.prepare(
        'SELECT COUNT(*) as count FROM entities WHERE collection = ?'
      ).get(col).count;
      
      if (originalCount !== migratedCount) {
        throw new Error(`Migration verification failed for ${col}: ${originalCount} → ${migratedCount}`);
      }
    }

    for (const key of SINGLETON_KEYS) {
      if (jsonData[key] === undefined) continue;
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row || JSON.stringify(JSON.parse(row.value)) !== JSON.stringify(jsonData[key])) {
        throw new Error(`Migration verification failed for singleton ${key}`);
      }
    }
    
    if (!preserveJson) {
      fs.renameSync(DB_JSON_FILE, `${DB_JSON_FILE}.backup`);
    }
    
    console.log('[DB] Migration completed successfully');
    if (preserveJson) {
      console.log('[DB] JSON source preserved by migration option');
    }
    
    return { migrated: true };
    
  } catch (error) {
    logSafeError('[DB] Migration failed', error);
    
    closeSqliteDb();
    removeSqliteArtifacts();
    
    throw new Error(`Migration failed: ${error.message}`);
  }
}

export function loadAllDataFromSqlite() {
  const db = getSqliteDb();
  const data = {};
  
  // Load collections (array-based)
  for (const collection of COLLECTION_KEYS) {
    const rows = db.prepare(
      'SELECT value FROM entities WHERE collection = ? ORDER BY updated_at'
    ).all(collection);
    
    data[collection] = rows.map(row => JSON.parse(row.value));
  }
  
  // Load singletons (object-based)
  for (const key of SINGLETON_KEYS) {
    const row = db.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).get(key);
    
    data[key] = row ? JSON.parse(row.value) : {};
  }
  
  return data;
}

export function loadCollectionFromSqlite(collection) {
  const db = getSqliteDb();
  ensureSchema(db);
  const rows = db.prepare(
    'SELECT value FROM entities WHERE collection = ? ORDER BY updated_at'
  ).all(collection);

  return rows.map((row) => JSON.parse(row.value));
}

export function loadSettingsSingletonFromSqlite(key = 'settings') {
  return loadSingletonFromSqlite(key);
}

export function loadSingletonFromSqlite(key) {
  const db = getSqliteDb();
  ensureSchema(db);
  const row = db.prepare(
    'SELECT value FROM settings WHERE key = ?'
  ).get(key);

  if (!row) {
    return null;
  }

  return JSON.parse(row.value);
}

export function upsertSettingsSingleton(key, value) {
  upsertSingleton(key, value);
}

export function upsertSingleton(key, value) {
  const db = getSqliteDb();
  ensureSchema(db);
  db.prepare(
    'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
  ).run(key, JSON.stringify(value), Date.now());
}

export function upsertEntity(collection, entity) {
  if (!collection || typeof collection !== 'string') {
    throw new TypeError('collection must be a non-empty string');
  }

  if (!entity || typeof entity !== 'object') {
    throw new TypeError('entity must be an object');
  }

  if (!entity.id || typeof entity.id !== 'string') {
    throw new TypeError('entity.id must be a non-empty string');
  }

  const db = getSqliteDb();
  ensureSchema(db);
  db.prepare(
    'INSERT OR REPLACE INTO entities (collection, id, value, updated_at) VALUES (?, ?, ?, ?)'
  ).run(collection, entity.id, JSON.stringify(entity), Date.now());
}

export function upsertEntities(collection, entities) {
  if (!collection || typeof collection !== 'string') {
    throw new TypeError('collection must be a non-empty string');
  }

  if (!Array.isArray(entities)) {
    throw new TypeError('entities must be an array');
  }

  const db = getSqliteDb();
  ensureSchema(db);
  const timestamp = Date.now();
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO entities (collection, id, value, updated_at) VALUES (?, ?, ?, ?)'
  );

  const transaction = db.transaction(() => {
    for (const entity of entities) {
      if (!entity || typeof entity !== 'object') {
        throw new TypeError('entity must be an object');
      }

      if (!entity.id || typeof entity.id !== 'string') {
        throw new TypeError('entity.id must be a non-empty string');
      }

      stmt.run(collection, entity.id, JSON.stringify(entity), timestamp);
    }
  });

  transaction();
}

export function deleteEntity(collection, id) {
  if (!collection || typeof collection !== 'string') {
    throw new TypeError('collection must be a non-empty string');
  }

  if (!id || typeof id !== 'string') {
    throw new TypeError('id must be a non-empty string');
  }

  const db = getSqliteDb();
  ensureSchema(db);
  db.prepare('DELETE FROM entities WHERE collection = ? AND id = ?').run(collection, id);
}

export function upsertHotState(provider, connectionId, state) {
  assertNonEmptyString(provider, 'provider');
  assertNonEmptyString(connectionId, 'connectionId');

  const sanitizedState = sanitizeHotState(state);
  if (Object.keys(sanitizedState).length === 0) {
    deleteHotState(provider, connectionId);
    return null;
  }

  const db = getSqliteDb();
  ensureSchema(db);
  db.prepare(
    'INSERT OR REPLACE INTO hot_state (provider, connection_id, value, updated_at) VALUES (?, ?, ?, ?)'
  ).run(provider, connectionId, JSON.stringify(sanitizedState), Date.now());
  return sanitizedState;
}

export function loadHotStates(provider, connectionIds) {
  assertNonEmptyString(provider, 'provider');
  if (!Array.isArray(connectionIds)) {
    throw new TypeError('connectionIds must be an array');
  }

  const rows = loadHotStateRows(provider, connectionIds);
  const result = {};
  for (const row of rows) {
    const parsed = parseHotStateRow(row);
    if (parsed) {
      result[row.connection_id] = parsed;
    }
  }
  return result;
}

export function loadProviderHotState(provider) {
  assertNonEmptyString(provider, 'provider');

  const rows = loadHotStateRows(provider);
  const result = {};
  for (const row of rows) {
    const parsed = parseHotStateRow(row);
    if (parsed) {
      result[row.connection_id] = parsed;
    }
  }
  return result;
}

export function deleteHotState(provider, connectionId) {
  assertNonEmptyString(provider, 'provider');
  assertNonEmptyString(connectionId, 'connectionId');

  const db = getSqliteDb();
  ensureSchema(db);
  db.prepare('DELETE FROM hot_state WHERE provider = ? AND connection_id = ?').run(provider, connectionId);
}

export function clearHotStateForProvider(provider) {
  assertNonEmptyString(provider, 'provider');

  const db = getSqliteDb();
  ensureSchema(db);
  db.prepare('DELETE FROM hot_state WHERE provider = ?').run(provider);
}

export function clearAllSqliteHotState() {
  const db = getSqliteDb();
  ensureSchema(db);
  db.prepare('DELETE FROM hot_state').run();
  saveHotStateMetadataMap({});
}

export function rebuildHotStateFromConnections(connections) {
  const db = getSqliteDb();
  ensureSchema(db);
  const list = Array.isArray(connections) ? connections : [];

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM hot_state').run();

    const stmt = db.prepare(
      'INSERT OR REPLACE INTO hot_state (provider, connection_id, value, updated_at) VALUES (?, ?, ?, ?)'
    );

    for (const connection of list) {
      if (!connection || typeof connection !== 'object') continue;
      const provider = connection.provider;
      const connectionId = connection.id || connection.connectionId;
      if (!provider || typeof provider !== 'string' || !connectionId || typeof connectionId !== 'string') continue;

      const sanitizedState = sanitizeHotState(connection);
      if (Object.keys(sanitizedState).length > 0) {
        stmt.run(provider, connectionId, JSON.stringify(sanitizedState), Date.now());
      }
    }
  });

  transaction();
}

export function saveAllDataToSqlite(data) {
  validateSqliteImportCollections(data);

  const db = getSqliteDb();
  ensureSchema(db);
  
  const transaction = db.transaction(() => {
    // Write collections
    for (const collection of COLLECTION_KEYS) {
      const items = data[collection] || [];
      
      // Delete removed items
      const ids = items.map(item => item.id).filter(Boolean);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM entities WHERE collection = ? AND id NOT IN (${placeholders})`
        ).run(collection, ...ids);
      } else {
        db.prepare(
          'DELETE FROM entities WHERE collection = ?'
        ).run(collection);
      }
      
      // Upsert items
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO entities (collection, id, value, updated_at) VALUES (?, ?, ?, ?)'
      );
      
      for (const item of items) {
        if (item.id) {
          stmt.run(collection, item.id, JSON.stringify(item), Date.now());
        }
      }
    }
    
    // Write singletons
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
    );
    
    for (const key of SINGLETON_KEYS) {
      if (data[key] !== undefined) {
        stmt.run(key, JSON.stringify(data[key]), Date.now());
      } else {
        db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      }
    }
  });
  
  transaction();
}

export { DB_SQLITE_FILE, DB_JSON_FILE };
