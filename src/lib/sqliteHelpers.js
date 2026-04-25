import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './dataDir.js';

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
  // eslint-disable-next-line global-require
  const BetterSqliteDatabase = require('better-sqlite3');
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
    const bunSqlite = import.meta.require?.('bun:sqlite');
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
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

let sqliteDb = null;

export function getSqliteDb() {
  if (sqliteDb) return sqliteDb;

  const Driver = loadDatabaseDriver();
  const db = new Driver(DB_SQLITE_FILE);

  // Enable WAL mode
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Performance optimizations
  db.pragma('cache_size = -64000'); // 64MB
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 30000000000'); // 30GB

  sqliteDb = db;
  return sqliteDb;
}

export function ensureSchema(db) {
  // Check if tables exist
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entities', 'settings', 'schema_version')"
  ).all();
  
  if (tables.length < 3) {
    const schemaPath = path.join(MIGRATIONS_DIR, '001_initial_schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);
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
    console.error('[DB] Migration failed:', error);
    
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

export function saveAllDataToSqlite(data) {
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
