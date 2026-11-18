import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { feedVideo } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';

function channelDb() {
  const db = openDb(':memory:');
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.subscribeChannel({ id: B, name: 'B' }, []);
  return db;
}

// 25 videos over 5 timestamps, so pages split inside runs of equal `published`.
function seed(db) {
  const videos = Array.from({ length: 25 }, (_, i) => feedVideo({
    id: `vid${String(i).padStart(8, '0')}`,
    channelId: i % 2 ? A : B,
    title: `Video ${i}`,
    published: new Date(Date.UTC(2025, 0, 1 + (i % 5))).toISOString(),
    isShort: i % 3 === 0,
    views: i,
  }));
  db.upsertVideos(videos);
  return videos;
}

function walk(db, query, limit) {
  const seen = [];
  let before = null;
  for (;;) {
    const { videos, more } = db.listVideos({ ...query, limit, before });
    seen.push(...videos);
    if (!more) return seen;
    before = videos.at(-1);
  }
}

test('keyset pages visit every matching row exactly once, newest first', () => {
  const db = channelDb();
  const videos = seed(db);
  for (const shorts of ['include', 'exclude', 'only']) {
    for (const limit of [1, 4, 7, 200]) {
      const seen = walk(db, { channelIds: [A, B], shorts, favoritesOnly: false }, limit);
      const expected = videos.filter((v) => shorts === 'include' || v.isShort === (shorts === 'only'));
      assert.equal(new Set(seen.map((v) => v.id)).size, seen.length, `no duplicates (${shorts}, ${limit})`);
      assert.deepEqual(seen.map((v) => v.id).sort(), expected.map((v) => v.id).sort(), `all rows (${shorts}, ${limit})`);
      const keys = seen.map((v) => v.published + v.id);
      assert.deepEqual(keys, [...keys].sort().reverse(), 'ordered by (published, id) descending');
    }
  }
});

test('channel, favorites and watched filters', () => {
  const db = channelDb();
  seed(db);
  const onlyA = walk(db, { channelIds: [A], shorts: 'include', favoritesOnly: false }, 5);
  assert.ok(onlyA.length > 0 && onlyA.every((v) => v.channelId === A));

  db.setFavorite('vid00000003', true);
  db.setFavorite('vid00000003', true);
  db.setFavorite('vid00000004', true);
  db.setFavorite('vid00000004', false);
  db.markWatched(['vid00000003', 'vid00000005', 'vid00000005']);
  const favs = walk(db, { channelIds: [A, B], shorts: 'include', favoritesOnly: true }, 5);
  assert.deepEqual(favs.map((v) => [v.id, v.favorite, v.watched]), [['vid00000003', true, true]]);
  const watched = walk(db, { channelIds: [A, B], shorts: 'include', favoritesOnly: false }, 200).filter((v) => v.watched);
  assert.deepEqual(watched.map((v) => v.id).sort(), ['vid00000003', 'vid00000005']);
});

test('channelStats splits counts, newest publish time and starred videos by long and short', () => {
  const db = channelDb();
  const videos = seed(db);
  const starred = [videos.find((v) => v.channelId === A && !v.isShort), videos.find((v) => v.channelId === A && v.isShort), videos.find((v) => v.channelId === B && !v.isShort)];
  for (const v of starred) db.setFavorite(v.id, true);
  db.setFavorite(starred[0].id, true);
  const stats = db.channelStats();
  const newest = (list) => list.map((v) => v.published).sort().at(-1) ?? null;
  for (const id of [A, B]) {
    const mine = videos.filter((v) => v.channelId === id);
    const long = mine.filter((v) => !v.isShort);
    const short = mine.filter((v) => v.isShort);
    const stars = starred.filter((v) => v.channelId === id);
    const tallies = {
      counts: { long: long.length, short: short.length, stream: 0 },
      latest: { long: newest(long), short: newest(short), stream: null },
      starred: { long: stars.filter((v) => !v.isShort).length, short: stars.filter((v) => v.isShort).length, stream: 0 },
      queued: { long: 0, short: 0, stream: 0 },
    };
    const all = { ...tallies, unwatched: tallies };
    assert.deepEqual(stats.get(id), { ...all, raw: all, inTopic: {} }, 'nothing is watched or muted, so every tally is the same');
  }
});

test('channelStats has a zero row for every channel, including one added after the stats were read', () => {
  const db = channelDb();
  seed(db);
  const tallies = {
    counts: { long: 0, short: 0, stream: 0 },
    latest: { long: null, short: null, stream: null },
    starred: { long: 0, short: 0, stream: 0 },
    queued: { long: 0, short: 0, stream: 0 },
  };
  const all = { ...tallies, unwatched: tallies };
  const empty = { ...all, raw: all, inTopic: {} };
  const C = 'UCcccccccccccccccccccccc';
  assert.equal(db.channelStats().has(C), false);
  db.subscribeChannel({ id: C, name: 'C' }, []);
  assert.deepEqual(db.channelStats().get(C), empty);
  assert.deepEqual([...db.channelStats().keys()].sort(), [A, B, C]);
  db.deleteChannel(C);
  assert.equal(db.channelStats().has(C), false);
});

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'subfeed-db-')), 'test.db');

function fixtureDb(name) {
  const file = tempFile();
  const db = new DatabaseSync(file);
  db.exec(readFileSync(join(import.meta.dirname, 'fixtures', `schema-${name}.sql`), 'utf8'));
  db.close();
  return file;
}

function schemaDump(file) {
  const db = new DatabaseSync(file);
  const dump = {
    userVersion: db.prepare('PRAGMA user_version').get().user_version,
    objects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
  };
  db.close();
  return dump;
}

test('a database from an older commit or from migration 1 ends with the same schema and user_version as a new one, and keeps its rows', () => {
  const fresh = tempFile();
  openDb(fresh).close();
  const expected = schemaDump(fresh);
  assert.ok(expected.userVersion >= 1);
  for (const [name, beforeMigrations] of [['a6fb071', true], ['896da07', true], ['a1e4dfa', true], ['migration-1', false], ['migration-2', false]]) {
    const file = fixtureDb(name);
    const old = new DatabaseSync(file);
    old.prepare('INSERT INTO channels (id, name) VALUES (?, ?)').run(A, 'A');
    old.prepare("INSERT INTO videos (id, channel_id, title, published, is_short, duration_s) VALUES ('vid00000001', ?, 'Live tonight', '2025-01-01T00:00:00.000Z', 0, 61)").run(A);
    old.close();
    for (let run = 0; run < 2; run++) openDb(file).close();
    assert.deepEqual(schemaDump(file), expected, name);
    const db = openDb(file);
    const query = { channelIds: [A], shorts: 'include', favoritesOnly: false, limit: 10 };
    const list = () => db.listVideos(query).videos;
    assert.deepEqual(list().map((v) => [v.id, v.title, v.durationS]), [['vid00000001', 'Live tonight', 61]], name);
    assert.deepEqual(db.searchPage({ ...query, q: 'tonight' }).videos.map((v) => v.id), ['vid00000001'], `${name}: the search index has the stored title`);
    if (beforeMigrations) {
      db.addRule({ kind: 'mute', pattern: 'live' });
      assert.deepEqual(list(), [], `${name}: rules see the folded words of a title stored before migrations`);
    }
    assert.deepEqual(db.listChannels().map((c) => [c.id, c.avatar]), [[A, null]], name);
    db.close();
  }
});

test('migration 5 gives a database with rows an empty backfills table that defaults its counts and refuses an unknown state', () => {
  const file = fixtureDb('migration-1');
  const old = new DatabaseSync(file);
  old.prepare('INSERT INTO channels (id, name) VALUES (?, ?)').run(A, 'A');
  old.close();
  openDb(file).close();
  const db = new DatabaseSync(file);
  assert.ok(db.prepare('PRAGMA user_version').get().user_version >= 5);
  assert.deepEqual(db.prepare('SELECT id FROM channels').all().map((r) => r.id), [A]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backfills').get().n, 0);
  db.prepare("INSERT INTO backfills (channel_id, state) VALUES (?, 'queued')").run(A);
  assert.deepEqual({ ...db.prepare('SELECT state, playlist, page_token, units, long_count, short_count FROM backfills').get() },
    { state: 'queued', playlist: null, page_token: null, units: 0, long_count: 0, short_count: 0 });
  assert.throws(() => db.prepare("UPDATE backfills SET state = 'paused'").run(), /CHECK constraint failed/);
  db.close();
});

test('migration 6 gives a database with rows a positions table whose rows go with their video when its channel is deleted', () => {
  const file = fixtureDb('migration-1');
  const old = new DatabaseSync(file);
  old.prepare('INSERT INTO channels (id, name) VALUES (?, ?)').run(A, 'A');
  old.prepare("INSERT INTO videos (id, channel_id, title, published) VALUES ('vid00000001', ?, 'Long talk', '2025-01-01T00:00:00.000Z')").run(A);
  old.close();
  openDb(file).close();
  const raw = new DatabaseSync(file);
  const save = raw.prepare('INSERT INTO positions (video_id, seconds, updated_at) VALUES (?, ?, ?)');
  save.run('vid00000001', 754, '2025-01-02T00:00:00.000Z');
  assert.throws(() => save.run('vid00000001', null, '2025-01-02T00:00:00.000Z'), /NOT NULL/);
  raw.close();
  const db = openDb(file);
  assert.equal(db.deleteChannel(A), true);
  db.close();
  const after = new DatabaseSync(file);
  assert.equal(after.prepare('SELECT count(*) AS n FROM positions').get().n, 0);
  after.close();
});

test('a database that lost meta with saved positions opens, keeps them, and ends with the schema of a new one', () => {
  const file = tempFile();
  const fresh = tempFile();
  openDb(fresh).close();
  const db = openDb(file);
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.upsertVideos([feedVideo({ id: 'vid00000000', channelId: A, title: 'Long talk' })]);
  db.close();
  const raw = new DatabaseSync(file);
  raw.prepare("INSERT INTO positions (video_id, seconds, updated_at) VALUES ('vid00000000', 754, '2025-01-02T00:00:00.000Z')").run();
  raw.exec('DROP TABLE meta; PRAGMA user_version = 0');
  raw.close();
  openDb(file).close();
  assert.deepEqual(schemaDump(file), schemaDump(fresh));
  assert.deepEqual(tableRows(file).positions.map((r) => [r.video_id, r.seconds]), [['vid00000000', 754]]);
  const again = openDb(file);
  assert.equal(again.deleteChannel(A), true);
  again.close();
  assert.deepEqual(tableRows(file).positions, []);
});

test('a seeded database with every channel deleted is not seeded again, from before migrations or after', () => {
  const load = () => ({ topics: [], channels: [{ id: B, name: 'B', topics: [] }] });
  const legacy = fixtureDb('896da07');
  const old = new DatabaseSync(legacy);
  old.exec('PRAGMA user_version = 1');
  old.close();
  const current = tempFile();
  const first = openDb(current);
  assert.equal(first.seedChannels(load), true);
  first.deleteChannel(B);
  first.close();
  for (const file of [legacy, current]) {
    const db = openDb(file);
    assert.equal(db.seedChannels(() => assert.fail('loaded the seed file again')), false);
    assert.deepEqual(db.listChannels(), []);
    db.close();
  }
});

test('a database from before migrations that has channels is not seeded, and an empty one is', () => {
  const load = () => ({ topics: [], channels: [{ id: B, name: 'B', topics: [] }] });
  const withChannels = fixtureDb('a6fb071');
  const old = new DatabaseSync(withChannels);
  old.prepare('INSERT INTO channels (id, name) VALUES (?, ?)').run(A, 'A');
  old.close();
  const db = openDb(withChannels);
  assert.equal(db.seedChannels(load), false);
  assert.deepEqual(db.listChannels().map((c) => c.id), [A]);
  const empty = openDb(fixtureDb('a6fb071'));
  assert.equal(empty.seedChannels(load), true);
  assert.deepEqual(empty.listChannels().map((c) => c.id), [B]);
});

test('getVideo reads one stored video with its favorite mark, and null for an unknown id', () => {
  const db = channelDb();
  const [first] = seed(db);
  assert.equal(db.getVideo('vidmissing00'), null);
  db.setFavorite(first.id, true);
  assert.deepEqual(db.getVideo(first.id), { ...first, isShort: true, kind: null, favorite: true, watched: false, queued: false, position: null });
  db.setFavorite(first.id, false);
  assert.equal(db.getVideo(first.id).favorite, false);
});

test('newVideos returns the newest few after since, strictly, and counts all of them', () => {
  const db = channelDb();
  const videos = seed(db);
  const since = new Date(Date.UTC(2025, 0, 3)).toISOString();
  const after = (shorts) => videos.filter((v) => v.published > since && (shorts === 'include' || !v.isShort));
  for (const shorts of ['include', 'exclude']) {
    const all = db.newVideos({ channelIds: [A, B], shorts, favoritesOnly: false, since, limit: 100 });
    assert.deepEqual(all.videos.map((v) => v.id).sort(), after(shorts).map((v) => v.id).sort(), `only videos after since (${shorts})`);
    assert.equal(all.total, after(shorts).length);
    const keys = all.videos.map((v) => v.published + v.id);
    assert.deepEqual(keys, [...keys].sort().reverse(), 'newest first');
    const few = db.newVideos({ channelIds: [A, B], shorts, favoritesOnly: false, since, limit: 3 });
    assert.deepEqual(few.videos, all.videos.slice(0, 3));
    assert.equal(few.total, all.total, 'the count ignores the limit');
  }
  assert.deepEqual(db.newVideos({ channelIds: [A], shorts: 'include', favoritesOnly: false, since, limit: 0 }), {
    videos: [],
    total: after('include').filter((v) => v.channelId === A).length,
  });
});

test('a feed page lists the same videos whether it seeks per channel, walks by publish time, or starts from favorites or the queue', () => {
  const db = openDb(':memory:');
  const ids = Array.from({ length: 8 }, (_, i) => `UC${String(i).padStart(22, '0')}`);
  for (const id of ids) db.subscribeChannel({ id, name: id }, []);
  const videos = Array.from({ length: 60 }, (_, i) => feedVideo({
    id: `vid${String(i).padStart(8, '0')}`,
    channelId: ids[i % 8],
    title: `Video ${i}`,
    published: new Date(Date.UTC(2025, 0, 1 + (i % 9))).toISOString(),
    isShort: i % 5 === 0,
    views: i,
    durationS: (i * 300) % 4000,
  }));
  db.upsertVideos(videos);
  const starred = videos.filter((_, i) => i % 3 === 0).map((v) => v.id);
  const queued = videos.filter((_, i) => i % 2 === 0).map((v) => v.id);
  for (const id of starred) db.setFavorite(id, true);
  for (const id of queued) db.enqueue(id);
  const newestFirst = (a, b) => b.published.localeCompare(a.published) || b.id.localeCompare(a.id);
  for (const channelIds of [ids.slice(0, 1), ids.slice(0, 3), ids]) {
    for (const [favoritesOnly, queuedOnly] of [[false, false], [true, false], [false, true], [true, true]]) {
      for (const length of ['any', 'long']) {
        const query = { channelIds, shorts: 'exclude', favoritesOnly, queuedOnly, length };
        const expected = videos
          .filter((v) => channelIds.includes(v.channelId) && !v.isShort && (length === 'any' || v.durationS > 45 * 60))
          .filter((v) => (!favoritesOnly || starred.includes(v.id)) && (!queuedOnly || queued.includes(v.id)))
          .sort(newestFirst);
        const label = JSON.stringify({ channels: channelIds.length, favoritesOnly, queuedOnly, length });
        assert.ok(expected.length > 0, `the fixture has matches for ${label}`);
        assert.deepEqual(walk(db, query, 4).map((v) => v.id), expected.map((v) => v.id), label);
      }
    }
  }
});

test('channelStats follows every write that changes it, from this connection or another', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-db-')), 'stats.db');
  const db = openDb(file);
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.subscribeChannel({ id: B, name: 'B' }, []);
  const videos = seed(db);
  const fresh = () => {
    const other = openDb(file);
    const stats = other.channelStats();
    other.close();
    return stats;
  };
  const check = (label) => assert.deepEqual(db.channelStats(), fresh(), label);
  check('after seeding');
  db.upsertVideos([{ ...videos[0], id: 'vidnew000001', published: '2026-01-01T00:00:00.000Z' }]);
  check('after a new video');
  db.upsertVideos([{ ...videos[1], isShort: !videos[1].isShort }]);
  check('after a video turns into a Short');
  db.applyDetails([{ id: videos[2].id, durationS: null, views: null, kind: 'upcoming' }]);
  check('after a video turns out to be a premiere');
  db.setFavorite(videos[3].id, true);
  check('after a favorite');
  db.enqueue(videos[4].id);
  check('after queueing');
  db.unqueueVideo(videos[4].id);
  check('after unqueueing');
  const other = new DatabaseSync(file);
  other.prepare("INSERT INTO favorites (video_id, added_at) VALUES (?, '2026-01-01')").run(videos[5].id);
  other.prepare('DELETE FROM videos WHERE id = ?').run(videos[6].id);
  other.close();
  check('after writes from another connection');
  db.deleteChannel(A);
  check('after deleting a channel');
  assert.equal(db.channelStats().has(A), false);
  db.close();
});

test('two connections to one file write at the same time without "database is locked"', async () => {
  const { Worker } = await import('node:worker_threads');
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-')), 'videos.db');
  openDb(file).subscribeChannel({ id: A, name: 'A' }, []);
  const source = `
    const { workerData, parentPort } = require('node:worker_threads');
    import(workerData.dbUrl).then(({ openDb }) => {
      const db = openDb(workerData.file);
      const ready = new Int32Array(workerData.ready);
      Atomics.add(ready, 0, 1);
      while (Atomics.load(ready, 0) < 2) Atomics.wait(ready, 0, 1, 5);
      let errors = 0;
      let written = 0;
      const until = Date.now() + 500;
      while (Date.now() < until) {
        const id = (workerData.prefix + written).padStart(11, 'x');
        try {
          db.upsertVideos([{ id, channelId: workerData.channelId, title: 't', published: new Date().toISOString(), thumbnail: null, isShort: false, views: null, durationS: null }]);
          written++;
        } catch {
          errors++;
        }
      }
      parentPort.postMessage({ errors, written });
    });
  `;
  const dbUrl = new URL('../src/db.mjs', import.meta.url).href;
  const ready = new SharedArrayBuffer(4);
  const run = (prefix) => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { dbUrl, file, prefix, channelId: A, ready } });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  const results = await Promise.all([run('a'), run('b')]);
  assert.deepEqual(results.map((r) => r.errors), [0, 0]);
  assert.equal(openDb(file).channelStats().get(A).counts.long, results[0].written + results[1].written);
});

test('several processes open and seed a new database file at the same time', async () => {
  const { Worker } = await import('node:worker_threads');
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-')), 'videos.db');
  const source = `
    const { workerData, parentPort } = require('node:worker_threads');
    import(workerData.dbUrl).then(({ openDb }) => {
      const ready = new Int32Array(workerData.ready);
      Atomics.add(ready, 0, 1);
      while (Atomics.load(ready, 0) < workerData.count) Atomics.wait(ready, 0, Atomics.load(ready, 0), 5);
      try {
        const seeded = openDb(workerData.file).seedChannels(() => ({ topics: [{ id: 't', name: 'T' }], channels: [{ id: workerData.channelId, name: 'A', topics: ['t'] }] }));
        parentPort.postMessage({ seeded });
      } catch (err) {
        parentPort.postMessage({ error: err.message });
      }
    });
  `;
  const dbUrl = new URL('../src/db.mjs', import.meta.url).href;
  const count = 4;
  const ready = new SharedArrayBuffer(4);
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { dbUrl, file, channelId: A, ready, count } });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  const results = await Promise.all(Array.from({ length: count }, run));
  assert.deepEqual(results.filter((r) => r.error), []);
  assert.equal(results.filter((r) => r.seeded).length, 1);
  const db = openDb(file);
  assert.deepEqual(db.listChannels().map((c) => [c.id, c.topics]), [[A, ['t']]]);
  assert.deepEqual(db.listTopics().map((t) => t.id), ['t']);
});

test('rows that point at a missing channel, topic or video are refused', () => {
  const db = channelDb();
  const ghost = 'UCgggggggggggggggggggggg';
  assert.throws(() => db.setTopicOnChannels('ghost-topic', [ghost], true), /FOREIGN KEY/);
  assert.throws(() => db.addRule({ kind: 'route', pattern: 'x', channelId: ghost, topicId: 'ghost-topic' }), /FOREIGN KEY/);
  assert.throws(() => db.subscribeChannel({ id: ghost, name: 'G' }, ['ghost-topic']), /FOREIGN KEY/);
  assert.equal(db.listChannels().some((c) => c.id === ghost), false);
  assert.throws(() => db.enqueue('vid99999999'), /FOREIGN KEY/);
  assert.deepEqual(db.listRules(), []);
});

function tableRows(file) {
  const raw = new DatabaseSync(file);
  const tables = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'videos_fts%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const rows = Object.fromEntries(tables.map(({ name }) => [name, raw.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map((r) => ({ ...r }))]));
  raw.close();
  return rows;
}

test('deleting a channel leaves no row of it, its videos or their marks in any table, and keeps the other channel', () => {
  const file = tempFile();
  const db = openDb(file);
  const topic = db.createTopic('Painting').id;
  db.subscribeChannel({ id: A, name: 'A' }, [topic]);
  db.subscribeChannel({ id: B, name: 'B' }, [topic]);
  const videos = seed(db);
  db.upsertVideos(videos.map((v) => ({ ...v, description: `About ${v.title}` })));
  for (const v of videos) {
    db.setFavorite(v.id, true);
    db.enqueue(v.id);
  }
  db.markWatched(videos.map((v) => v.id));
  db.addRule({ kind: 'mute', pattern: 'never', channelId: A });
  db.addRule({ kind: 'route', pattern: 'never', channelId: A, topicId: topic });
  db.addRule({ kind: 'mute', pattern: 'never', channelId: B });
  assert.equal(db.deleteChannel(A), true);
  assert.equal(db.deleteChannel(A), false);
  const rows = JSON.stringify(tableRows(file));
  assert.equal(rows.includes(A), false);
  for (const v of videos.filter((v) => v.channelId === A)) assert.equal(rows.includes(v.id), false, v.id);
  for (const v of videos.filter((v) => v.channelId === B)) assert.equal(rows.includes(v.id), true, v.id);
  assert.equal(rows.includes(B), true);
  assert.equal(db.searchPage({ q: 'about', channelIds: [A, B], shorts: 'include', limit: 1 }).total, videos.filter((v) => v.channelId === B).length);
  assert.equal(db.deleteTopic(topic), true);
  assert.deepEqual(db.listChannels().map((c) => c.topics), [[]]);
  assert.deepEqual(db.listRules().map((r) => r.channelId), [B]);
  db.close();
});

test('migration 3 deletes the rows that point at nothing and keeps every other row and search hit', () => {
  const file = fixtureDb('migration-2');
  const old = new DatabaseSync(file);
  const insert = (sql, ...values) => old.prepare(sql).run(...values);
  insert("INSERT INTO topics (id, name) VALUES ('paint', 'Paint')");
  insert("INSERT INTO channels (id, name) VALUES (?, 'A'), (?, 'B')", A, B);
  const ghost = 'UCgggggggggggggggggggggg';
  const video = (id, channel, title) => insert("INSERT INTO videos (id, channel_id, title, published, is_short) VALUES (?, ?, ?, '2025-01-01T00:00:00.000Z', 0)", id, channel, title);
  video('vidaaaaaaa1', A, 'Painting goblins');
  video('vidgggggggg', ghost, 'Painting ghosts');
  video('vidbbbbbbb1', B, 'Basing tutorial');
  insert("INSERT INTO video_descriptions (video_id, description) VALUES ('vidbbbbbbb1', 'Sand and paint')");
  for (const table of ['favorites', 'watched', 'queue']) {
    insert(`INSERT INTO ${table} (video_id) VALUES ('vidaaaaaaa1'), ('vidgggggggg'), ('vidmissing0')`);
  }
  insert("INSERT INTO channel_topics (channel_id, topic_id) VALUES (?, 'paint'), (?, 'ghost-topic'), (?, 'paint')", A, A, ghost);
  insert("INSERT INTO rules (kind, pattern, words, channel_id, topic_id) VALUES ('mute', 'nothing', ' nothing ', NULL, NULL), ('mute', 'nothing', ' nothing ', ?, NULL), ('route', 'x', ' x ', ?, 'paint'), ('route', 'x', ' x ', ?, 'paint'), ('mute', 'x', ' x ', ?, NULL)", A, B, ghost, ghost);
  old.close();
  const search = (db, q) => db.searchPage({ q, channelIds: [A, B], shorts: 'include', limit: 10 }).videos.map((v) => v.id).sort();

  const db = openDb(file);
  assert.deepEqual(search(db, 'paint'), ['vidaaaaaaa1', 'vidbbbbbbb1']);
  assert.deepEqual(search(db, 'basing'), ['vidbbbbbbb1']);
  db.close();
  const rows = tableRows(file);
  assert.deepEqual(rows.videos.map((v) => v.id), ['vidaaaaaaa1', 'vidbbbbbbb1']);
  for (const table of ['favorites', 'watched', 'queue']) assert.deepEqual(rows[table].map((r) => r.video_id), ['vidaaaaaaa1'], table);
  assert.deepEqual(rows.channel_topics, [{ channel_id: A, topic_id: 'paint' }]);
  assert.deepEqual(rows.rules.map((r) => [r.channel_id, r.topic_id]), [[null, null], [A, null], [B, 'paint']]);
  assert.deepEqual(rows.video_descriptions, [{ video_id: 'vidbbbbbbb1', description: 'Sand and paint' }]);
  const raw = new DatabaseSync(file);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  raw.close();
});
