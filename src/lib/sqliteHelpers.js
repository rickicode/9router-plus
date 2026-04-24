import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '@/lib/dataDir.js';

const DB_SQLITE_FILE = path.join(DATA_DIR, 'db.sqlite');
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

let sqliteDb = null;

export function getSqliteDb() {
  if (sqliteDb) return sqliteDb;

  const db = new Database(DB_SQLITE_FILE);

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
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entities', 'settings')"
  ).all();
  
  if (tables.length === 0) {
    // Phase 3: create the temporary SQLite read-side schema while lowdb remains the write-side source.
    const schemaPath = path.join(MIGRATIONS_DIR, '001_initial_schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);
  }
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
    
    // Phase 3: create the temporary SQLite read mirror while lowdb remains the active write backend.
    const db = getSqliteDb();
    ensureSchema(db);
    
    // Populate data in transaction
    const transaction = db.transaction(() => {
      // Migrate collections
      const collections = ['providerConnections', 'providerNodes',
                          'proxyPools', 'combos', 'apiKeys', 'customModels'];
      
      const entityStmt = db.prepare(
        'INSERT INTO entities (collection, id, value, updated_at) VALUES (?, ?, ?, ?)'
      );
      
      for (const collection of collections) {
        const items = jsonData[collection] || [];
        for (const item of items) {
          if (item.id) {
            entityStmt.run(collection, item.id, JSON.stringify(item), Date.now());
          }
        }
      }
      
      // Migrate singletons
      const singletonKeys = ['settings', 'modelAliases', 'pricing', 'mitmAlias', 'opencodeSync'];
      const settingStmt = db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
      );
      
      for (const key of singletonKeys) {
        if (jsonData[key] !== undefined) {
          settingStmt.run(key, JSON.stringify(jsonData[key]), Date.now());
        }
      }
    });
    
    transaction();
    
    // Verify migration
    const collections = ['providerConnections', 'apiKeys', 'combos'];
    for (const col of collections) {
      const originalCount = (jsonData[col] || []).length;
      const migratedCount = db.prepare(
        'SELECT COUNT(*) as count FROM entities WHERE collection = ?'
      ).get(col).count;
      
      if (originalCount !== migratedCount) {
        throw new Error(`Migration verification failed for ${col}: ${originalCount} → ${migratedCount}`);
      }
    }
    
    if (!preserveJson) {
      fs.renameSync(DB_JSON_FILE, `${DB_JSON_FILE}.backup`);
    }
    
    console.log('[DB] Migration completed successfully');
    if (preserveJson) {
      console.log('[DB] JSON source preserved because Phase 3 keeps writes on lowdb while reads may prefer SQLite');
    }
    
    return { migrated: true };
    
  } catch (error) {
    console.error('[DB] Migration failed:', error);
    
    // Cleanup failed SQLite file
    if (fs.existsSync(DB_SQLITE_FILE)) {
      fs.unlinkSync(DB_SQLITE_FILE);
    }
    
    throw new Error(`Migration failed: ${error.message}`);
  }
}

export function loadAllDataFromSqlite() {
  const db = getSqliteDb();
  const data = {};
  
  // Load collections (array-based)
  const collections = ['providerConnections', 'providerNodes', 
                      'proxyPools', 'combos', 'apiKeys', 'customModels'];
  
  for (const collection of collections) {
    const rows = db.prepare(
      'SELECT value FROM entities WHERE collection = ? ORDER BY updated_at'
    ).all(collection);
    
    data[collection] = rows.map(row => JSON.parse(row.value));
  }
  
  // Load singletons (object-based)
  const singletonKeys = ['settings', 'modelAliases', 'pricing', 'mitmAlias', 'opencodeSync'];
  
  for (const key of singletonKeys) {
    const row = db.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).get(key);
    
    data[key] = row ? JSON.parse(row.value) : {};
  }
  
  return data;
}

export function loadCollectionFromSqlite(collection) {
  const db = getSqliteDb();
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
    const collections = ['providerConnections', 'providerNodes',
                        'proxyPools', 'combos', 'apiKeys', 'customModels'];
    
    for (const collection of collections) {
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
    const singletonKeys = ['settings', 'modelAliases', 'pricing', 'mitmAlias', 'opencodeSync'];
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
    );
    
    for (const key of singletonKeys) {
      if (data[key] !== undefined) {
        stmt.run(key, JSON.stringify(data[key]), Date.now());
      }
    }
  });
  
  transaction();
}

export { DB_SQLITE_FILE, DB_JSON_FILE };
