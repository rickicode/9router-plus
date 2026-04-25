import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tempDirs = [];
let sqliteHelpersModule = null;

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '9router-sqlite-pragmas-'));
  tempDirs.push(dir);
  return dir;
}

async function loadSqliteHelpers() {
  vi.resetModules();
  sqliteHelpersModule = await import('../../src/lib/sqliteHelpers.js');
  return sqliteHelpersModule;
}

beforeEach(async () => {
  process.env.DATA_DIR = await createTempDataDir();
});

afterEach(async () => {
  sqliteHelpersModule?.closeSqliteDb?.();
  sqliteHelpersModule = null;
  delete process.env.DATA_DIR;
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('sqlite pragmas', () => {
  it('keeps WAL and synchronous NORMAL while bounding mmap_size', async () => {
    const sqliteHelpers = await loadSqliteHelpers();
    const db = sqliteHelpers.getSqliteDb();

    const journalMode = db.pragma('journal_mode', { simple: true });
    const syncMode = db.pragma('synchronous', { simple: true });
    const cacheSize = db.pragma('cache_size', { simple: true });
    const tempStore = db.pragma('temp_store', { simple: true });
    const mmapSize = db.pragma('mmap_size', { simple: true });

    const SQLITE_SYNCHRONOUS_NORMAL = 1;
    const SQLITE_TEMP_STORE_MEMORY = 2;
    const CACHE_SIZE_PAGES = -64000;
    const ONE_GIB = 1024 * 1024 * 1024;

    expect(String(journalMode).toLowerCase()).toBe('wal');
    expect(Number(syncMode)).toBe(SQLITE_SYNCHRONOUS_NORMAL);
    expect(Number(cacheSize)).toBe(CACHE_SIZE_PAGES);
    expect(Number(tempStore)).toBe(SQLITE_TEMP_STORE_MEMORY);
    expect(Number.isFinite(Number(mmapSize))).toBe(true);
    expect(Number(mmapSize)).toBe(ONE_GIB);
  });

  it('reapplies pragma defaults when the sqlite connection is reopened', async () => {
    const sqliteHelpers = await loadSqliteHelpers();
    const db = sqliteHelpers.getSqliteDb();

    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(Number(db.pragma('synchronous', { simple: true }))).toBe(1);
    expect(Number(db.pragma('cache_size', { simple: true }))).toBe(-64000);
    expect(Number(db.pragma('temp_store', { simple: true }))).toBe(2);
    expect(Number(db.pragma('mmap_size', { simple: true }))).toBe(1024 * 1024 * 1024);

    sqliteHelpers.closeSqliteDb();

    const reopenedDb = sqliteHelpers.getSqliteDb();

    expect(String(reopenedDb.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(Number(reopenedDb.pragma('synchronous', { simple: true }))).toBe(1);
    expect(Number(reopenedDb.pragma('cache_size', { simple: true }))).toBe(-64000);
    expect(Number(reopenedDb.pragma('temp_store', { simple: true }))).toBe(2);
    expect(Number(reopenedDb.pragma('mmap_size', { simple: true }))).toBe(1024 * 1024 * 1024);
  });
});
