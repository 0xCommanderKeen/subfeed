import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backfills } from './db/backfills.mjs';
import { library } from './db/library.mjs';
import { listing, searchPageOn } from './db/listing.mjs';
import { stats } from './db/stats.mjs';
import { videoWriter, videos } from './db/videos.mjs';
import { spacedWords } from '../public/vocab.js';
import { migrate } from './schema.mjs';

export { LENGTH_FILTER } from './db/filters.mjs';
export { slugify, topicGroup } from './db/library.mjs';
export { MATCH_COUNT_CAP } from './db/listing.mjs';

export const DB_PATH = join(import.meta.dirname, '..', 'data', 'subfeed.db');

// "ok", or the problems SQLite found, one per line.
export function quickCheck(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('PRAGMA quick_check').all().map((r) => r.quick_check).join('\n');
  } finally {
    db.close();
  }
}

// Switching a new file to WAL needs an exclusive lock, and SQLite answers SQLITE_BUSY at once, without busy_timeout,
// while another process opening the same file holds a lock. Once one of them has switched, the setting is a no-op.
function useWal(db) {
  const until = Date.now() + 5000;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if ((err.errcode & 0xff) !== 5 || Date.now() > until) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

// Analyzes the tables whose planner statistics are missing or stale, and is cheap when they are current. It checks every
// table, not only those this connection has queried, because statistics taken while the search index was nearly empty
// make every later insert about three times slower until they are redone.
const OPTIMIZE = 'PRAGMA optimize = 0x10002';

// Search on a connection of its own, for the server's search worker. It never writes; openDb has made the schema.
export function openSearchDb(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return searchPageOn(db);
}

export function openDb(file, { now = () => new Date() } = {}) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.function('spaced_words', { deterministic: true }, spacedWords);
  // The server and bin/backfill.mjs may write at the same time.
  db.exec('PRAGMA busy_timeout = 5000');
  useWal(db);
  migrate(db);
  db.exec(OPTIMIZE);

  // IMMEDIATE takes the write lock up front. A deferred transaction that reads first fails at once with SQLITE_BUSY
  // when it tries to write after another connection committed, and busy_timeout does not retry that.
  const inTransaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const stamp = () => now().toISOString();
  const writeVideos = videoWriter(db, stamp);

  return {
    now,
    ...videos(db, inTransaction, writeVideos, stamp),
    ...backfills(db, inTransaction, writeVideos),
    ...listing(db),
    ...stats(db),
    ...library(db, inTransaction, stamp),

    // A long-running process should call this now and then, so the statistics follow the tables as they grow.
    optimize() {
      db.exec(OPTIMIZE);
    },

    // Unlike copying the file, this includes writes still in the WAL. The file must not exist yet.
    snapshot(file) {
      db.prepare('VACUUM INTO ?').run(file);
    },

    close() {
      db.close();
    },
  };
}
