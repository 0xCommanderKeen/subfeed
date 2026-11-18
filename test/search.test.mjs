import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { feedVideo } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const ANY = { shorts: 'include', favoritesOnly: false };

const video = (n, channelId, title, extra = {}) =>
  feedVideo({ id: `vid${String(n).padStart(8, '0')}`, channelId, title, published: new Date(Date.UTC(2025, 0, 1 + (n % 4))).toISOString(), ...extra });

function channelDb() {
  const db = openDb(':memory:');
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.subscribeChannel({ id: B, name: 'B' }, []);
  return db;
}

const search = (db, q, query = {}) => db.searchPage({ channelIds: [A, B], ...ANY, limit: 200, q, ...query }).videos.map((v) => v.id);

function walk(db, query, limit) {
  const seen = [];
  let before = null;
  for (;;) {
    const { videos, more } = db.searchPage({ ...query, limit, before });
    seen.push(...videos);
    if (!more) return seen;
    before = videos.at(-1);
  }
}

test('search matches word prefixes in any order, ignoring case and accents', () => {
  const db = channelDb();
  db.upsertVideos([
    video(1, A, 'Lizardmen in Blood Bowl'),
    video(2, A, 'Printing PETG at speed'),
    video(3, B, 'Café racer rebuild'),
    video(4, B, 'Blood on the dance floor'),
  ]);
  assert.deepEqual(search(db, 'lizard'), ['vid00000001']);
  assert.deepEqual(search(db, 'BOWL blood'), ['vid00000001']);
  assert.deepEqual(search(db, 'petg'), ['vid00000002']);
  assert.deepEqual(search(db, 'cafe'), ['vid00000003']);
  assert.deepEqual(search(db, 'blood').sort(), ['vid00000001', 'vid00000004']);
  assert.deepEqual(search(db, 'zard'), [], 'matches start at a word boundary');
});

test('FTS syntax in the query is searched as plain words and never throws', () => {
  const db = channelDb();
  db.upsertVideos([video(1, A, 'Blood Bowl: the NEAR future (part 2)'), video(2, A, 'Bowl or plate'), video(3, A, 'Plate')]);
  assert.deepEqual(search(db, '"blood bowl'), ['vid00000001']);
  assert.deepEqual(search(db, 'blood* bowl:'), ['vid00000001']);
  assert.deepEqual(search(db, 'NEAR(blood'), ['vid00000001']);
  assert.deepEqual(search(db, 'bowl OR plate'), ['vid00000002'], 'OR is a word, not an operator');
  assert.deepEqual(search(db, '-plate').toSorted(), ['vid00000002', 'vid00000003'], 'a leading minus does not exclude');
  for (const q of ['"', '*', '(', ')', 'AND', 'NOT', '^', 'title:x', "'", '{a b}', '+', '!!!', '🙂', 'a"b"c', '\\']) {
    assert.doesNotThrow(() => search(db, q), `q ${q}`);
  }
  assert.deepEqual(search(db, '!!!'), [], 'no words match nothing');
  assert.equal(db.searchPage({ channelIds: [A], ...ANY, q: '!!!', limit: 1 }).total, 0);
});

test('the index follows inserts, title changes and deleted channels', () => {
  const db = channelDb();
  db.upsertVideos([video(1, A, 'Original title'), video(2, B, 'Glider build', { description: 'balsa wings' }), video(3, B, 'Glider maiden flight')]);
  assert.deepEqual(search(db, 'original'), ['vid00000001']);

  db.upsertVideos([video(1, A, 'Renamed title')]);
  assert.deepEqual(search(db, 'original'), [], 'the old title is gone');
  assert.deepEqual(search(db, 'renamed'), ['vid00000001']);
  db.upsertVideos([video(1, A, 'Renamed title')]);
  assert.deepEqual(search(db, 'title'), ['vid00000001'], 'an unchanged title is listed once');

  db.deleteChannel(B);
  // New rows reuse the deleted rows' rowids; a stale index would map B's words onto them.
  db.upsertVideos([video(5, A, 'Something else'), video(6, A, 'Another thing')]);
  assert.deepEqual(search(db, 'glider', { channelIds: [A, B] }), []);
  assert.equal(db.searchPage({ channelIds: [A, B], ...ANY, q: 'glider', limit: 1 }).total, 0);
  assert.deepEqual(search(db, 'thing'), ['vid00000006']);
  db.subscribeChannel({ id: B, name: 'B' }, []);
  db.upsertVideos([video(2, B, 'Glider build')]);
  assert.deepEqual(search(db, 'balsa'), [], 'a deleted video takes its description with it');
});

test('q combines with channel, Shorts and length filters, and keyset pages cover every match once', () => {
  const db = channelDb();
  const videos = Array.from({ length: 60 }, (_, i) =>
    video(i, i % 2 ? A : B, i % 3 ? `Blood Bowl match ${i}` : `Painting ${i}`, {
      isShort: i % 7 === 0,
      durationS: i % 5 === 0 ? null : 300 + i * 60,
    }));
  db.upsertVideos(videos);
  const medium = (v) => v.durationS !== null && v.durationS >= 900 && v.durationS <= 2700;
  const cases = [
    [{ channelIds: [A, B], shorts: 'exclude', length: 'medium' }, (v) => !v.isShort && medium(v)],
    [{ channelIds: [A], shorts: 'include', length: 'any' }, (v) => v.channelId === A],
    [{ channelIds: [A, B], shorts: 'only', length: 'any' }, (v) => v.isShort],
    [{ channelIds: [B], shorts: 'include', length: 'long' }, (v) => v.channelId === B && v.durationS > 2700],
  ];
  for (const [filters, keep] of cases) {
    const expected = videos.filter((v) => v.title.startsWith('Blood') && keep(v)).map((v) => v.id);
    assert.ok(expected.length > 3, 'the case spans several pages');
    for (const limit of [1, 3, 200]) {
      const seen = walk(db, { ...filters, favoritesOnly: false, q: 'bowl' }, limit);
      const ids = seen.map((v) => v.id);
      assert.equal(new Set(ids).size, ids.length, `no duplicates (${JSON.stringify(filters)}, ${limit})`);
      assert.deepEqual(ids.toSorted(), expected.toSorted(), `every match (${JSON.stringify(filters)}, ${limit})`);
      for (let i = 1; i < seen.length; i++) {
        const [a, b] = [seen[i - 1], seen[i]];
        assert.ok(a.rank < b.rank || (a.rank === b.rank && a.published + a.id > b.published + b.id), 'best match first, then newest');
      }
    }
    assert.equal(db.searchPage({ ...filters, favoritesOnly: false, q: 'bowl', limit: 1 }).total, expected.length);
  }
});

test('descriptions are searched, a title match ranks above a description match, and newer videos break ties', () => {
  const db = channelDb();
  db.upsertVideos([
    video(1, A, 'Printing tips', { description: 'Today: PETG, PETG and more PETG on the printer.' }),
    video(2, B, 'PETG strength test', { description: 'Pulling parts apart.' }),
    video(3, A, 'PETG strength demo', { description: 'Pulling parts apart.' }),
    video(4, B, 'Blood Bowl', { description: 'Lizardmen against Dwarfs.' }),
  ]);
  assert.deepEqual(search(db, 'petg'), ['vid00000003', 'vid00000002', 'vid00000001'], 'titles first; the newer of two equal matches first');
  assert.deepEqual(search(db, 'blood lizard'), ['vid00000004'], 'words may match in different fields');
  assert.deepEqual(search(db, 'printer'), ['vid00000001']);
});

test('a source without descriptions keeps the stored one, and a changed description is searched instead of the old', () => {
  const db = channelDb();
  db.upsertVideos([video(1, A, 'Episode', { description: 'about lizardmen' })]);
  db.upsertVideos([video(1, A, 'Episode')]);
  assert.deepEqual(search(db, 'lizardmen'), ['vid00000001']);
  db.upsertVideos([video(1, A, 'Episode', { description: 'about skaven' })]);
  assert.deepEqual(search(db, 'lizardmen'), []);
  assert.deepEqual(search(db, 'skaven'), ['vid00000001']);
});

test('one batch stores every description, the last one for a repeated video, and none for a video it did not store', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-')), 'test.db');
  const db = openDb(file);
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.upsertVideos([
    video(1, A, 'Episode one', { description: 'about lizardmen' }),
    video(2, A, 'Episode two', { description: 'about skaven' }),
    video(2, A, 'Episode two', { description: 'about dwarfs' }),
    video(3, 'UCunknownunknownunknown0', 'Elsewhere', { description: 'about orcs' }),
  ]);
  assert.deepEqual(search(db, 'lizardmen'), ['vid00000001']);
  assert.deepEqual(search(db, 'dwarfs'), ['vid00000002']);
  assert.deepEqual(search(db, 'skaven'), []);
  assert.deepEqual(search(db, 'orcs'), []);
  const raw = new DatabaseSync(file);
  assert.deepEqual(raw.prepare('SELECT video_id FROM video_descriptions ORDER BY video_id').all().map((r) => r.video_id), ['vid00000001', 'vid00000002']);
});

test('ranked keyset pages cover every match once, in rank order', () => {
  const db = channelDb();
  const videos = Array.from({ length: 40 }, (_, i) =>
    video(i, i % 2 ? A : B, i % 3 ? `Kitchen ${'word '.repeat(i % 5)}${i}` : `Other ${i}`, { description: i % 4 ? `kitchen ${'filler '.repeat(i)}` : null }));
  db.upsertVideos(videos);
  const all = db.searchPage({ channelIds: [A, B], ...ANY, q: 'kitchen', limit: 200 }).videos;
  assert.ok(new Set(all.map((v) => v.rank)).size > 5, 'ranks differ');
  for (const limit of [1, 4, 7]) {
    assert.deepEqual(walk(db, { channelIds: [A, B], ...ANY, q: 'kitchen' }, limit).map((v) => v.id), all.map((v) => v.id), `limit ${limit}`);
  }
});

test('a database with a title-only index gets one over titles and descriptions', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-search-')), 'titles.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE videos (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, title TEXT, published TEXT, thumbnail TEXT,
    is_short INTEGER, views INTEGER, duration_s INTEGER, first_seen TEXT, updated_at TEXT)`);
  old.exec('CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, handle TEXT, subscribed INTEGER NOT NULL DEFAULT 1, favorite INTEGER NOT NULL DEFAULT 0, added_at TEXT)');
  old.exec(`CREATE VIRTUAL TABLE videos_fts USING fts5(title, content = 'videos', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
    CREATE TRIGGER videos_fts_insert AFTER INSERT ON videos BEGIN INSERT INTO videos_fts (rowid, title) VALUES (new.rowid, new.title); END;`);
  old.prepare('INSERT INTO channels (id, name) VALUES (?, ?)').run(A, 'A');
  old.prepare("INSERT INTO videos (id, channel_id, title, published, is_short) VALUES ('vid00000001', ?, 'Stored title', '2025-01-01T00:00:00.000Z', 0)").run(A);
  old.close();
  for (let run = 0; run < 2; run++) openDb(file).close();
  const db = openDb(file);
  assert.deepEqual(search(db, 'stored', { channelIds: [A] }), ['vid00000001']);
  db.upsertVideos([video(1, A, 'Stored title', { description: 'filled in by the backfill' })]);
  assert.deepEqual(search(db, 'backfill', { channelIds: [A] }), ['vid00000001']);
  db.close();
});

test('a database from before search gets an index of its existing titles, once', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-search-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE videos (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, title TEXT, published TEXT, thumbnail TEXT,
    is_short INTEGER, views INTEGER, duration_s INTEGER, first_seen TEXT, updated_at TEXT)`);
  old.exec('CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, handle TEXT, subscribed INTEGER NOT NULL DEFAULT 1, favorite INTEGER NOT NULL DEFAULT 0, added_at TEXT)');
  old.prepare('INSERT INTO channels (id, name) VALUES (?, ?)').run(A, 'A');
  old.prepare("INSERT INTO videos (id, channel_id, title, published, is_short) VALUES ('vid00000001', ?, 'Stored before search', '2025-01-01T00:00:00.000Z', 0)").run(A);
  old.close();
  for (let run = 0; run < 2; run++) openDb(file).close();
  const db = openDb(file);
  assert.deepEqual(search(db, 'stored', { channelIds: [A] }), ['vid00000001']);
  db.upsertVideos([video(2, A, 'Stored after search')]);
  assert.deepEqual(search(db, 'stored', { channelIds: [A] }).toSorted(), ['vid00000001', 'vid00000002']);
  db.close();
});
