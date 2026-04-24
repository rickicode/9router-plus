import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR } from '@/lib/dataDir.js';

const DB_SQLITE_FILE = path.join(DATA_DIR, 'db.sqlite');

let sqliteDb = null;

export function getSqliteDb() {
  if (sqliteDb) return sqliteDb;
  
  sqliteDb = new Database(DB_SQLITE_FILE);
  
  // Enable WAL mode
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('synchronous = NORMAL');
  
  // Performance optimizations
  sqliteDb.pragma('cache_size = -64000'); // 64MB
  sqliteDb.pragma('temp_store = MEMORY');
  sqliteDb.pragma('mmap_size = 30000000000'); // 30GB
  
  return sqliteDb;
}

export function ensureSchema(db) {
  // Check if tables exist
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entities', 'settings')"
  ).all();
  
  if (tables.length === 0) {
    // Run migration
    const schemaPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'migrations', '001_initial_schema.sql');
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
  // Check if migration needed
  const jsonExists = fs.existsSync(DB_JSON_FILE);
  const sqliteExists = fs.existsSync(DB_SQLITE_FILE);
  
  if (!jsonExists || sqliteExists) {
    return { migrated: false, reason: sqliteExists ? 'already_migrated' : 'no_json' };
  }
  
  console.log('[DB] Starting migration from JSON to SQLite...');
  
  try {
    // Read JSON data
    const jsonData = JSON.parse(fs.readFileSync(DB_JSON_FILE, 'utf-8'));
    
    // Create SQLite with schema
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
    
    // Backup original JSON
    fs.renameSync(DB_JSON_FILE, `${DB_JSON_FILE}.backup`);
    
    console.log('[DB] Migration completed successfully');
    console.log(`[DB] Backup saved to ${DB_JSON_FILE}.backup`);
    
    return { migrated: true, backupPath: `${DB_JSON_FILE}.backup` };
    
  } catch (error) {
    console.error('[DB] Migration failed:', error);
    
    // Cleanup failed SQLite file
    if (fs.existsSync(DB_SQLITE_FILE)) {
      fs.unlinkSync(DB_SQLITE_FILE);
    }
    
    throw new Error(`Migration failed: ${error.message}`);
  }
}

export { DB_SQLITE_FILE, DB_JSON_FILE };
