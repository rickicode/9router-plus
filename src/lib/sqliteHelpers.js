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

export { DB_SQLITE_FILE };
