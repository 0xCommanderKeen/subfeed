import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { daysToKeep, isoWeek, runBackup, scheduleBackups, scheduleOptimize } from '../src/backup.mjs';
import { parseChannelsFile } from '../src/channels-file.mjs';
import { openDb } from '../src/db.mjs';
import { feedVideo } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const tempDir = () => mkdtempSync(join(tmpdir(), 'subfeed-backup-'));
const at = (day) => new Date(`${day}T00:30:00Z`);

function* daysFrom(first, last) {
  for (let d = new Date(`${first}T00:00:00Z`); d <= new Date(`${last}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

test('isoWeek follows the Thursday rule across year boundaries', () => {
  assert.equal(isoWeek('2026-12-31'), '2026-W53');
  assert.equal(isoWeek('2027-01-01'), '2026-W53');
  assert.equal(isoWeek('2027-01-03'), '2026-W53');
  assert.equal(isoWeek('2027-01-04'), '2027-W01');
  assert.equal(isoWeek('2025-12-29'), '2026-W01');
  assert.equal(isoWeek('2026-11-15'), '2026-W46');
  assert.equal(isoWeek('2026-11-16'), '2026-W47');
});

test('daily runs keep 7 dailies and the newest snapshot of 4 older ISO weeks', () => {
  const dir = tempDir();
  const db = openDb(':memory:');
  db.subscribeChannel({ id: A, name: 'Alpha' }, []);
  for (const day of daysFrom('2026-11-01', '2027-01-06')) runBackup(db, { now: at(day), dir });

  // Dailies Dec 31 to Jan 6. Older weeks: 2026-W53 (Mon Dec 28) keeps Wed Dec 30, then the Sundays of W52, W51, W50.
  const expected = ['2026-12-13', '2026-12-20', '2026-12-27', '2026-12-30', ...daysFrom('2026-12-31', '2027-01-06')];
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.db')).sort(), expected.map((d) => `subfeed-${d}.db`));
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.json')).sort(), expected.map((d) => `channels-${d}.json`));
  assert.ok(!readdirSync(dir).some((f) => f.endsWith('.partial')));
});

test('a second run on the same day changes nothing, and a long gap keeps the last snapshots', () => {
  const dir = tempDir();
  const db = openDb(':memory:');
  for (const day of daysFrom('2026-11-01', '2026-11-20')) runBackup(db, { now: at(day), dir });
  const before = readdirSync(dir).sort();
  const again = runBackup(db, { now: new Date('2026-11-20T23:59:00Z'), dir });
  assert.equal(again.created, false);
  assert.deepEqual(again.removed, []);
  assert.deepEqual(readdirSync(dir).sort(), before);

  const later = runBackup(db, { now: at('2027-03-01'), dir });
  assert.equal(later.created, true);
  assert.deepEqual(later.removed, ['2026-11-13'], 'Nov 14 left the dailies and now stands for W46 instead of Nov 13');
});

test('daysToKeep ignores how the input is ordered', () => {
  const days = [...daysFrom('2026-10-01', '2026-11-15')];
  assert.deepEqual([...daysToKeep(days.toReversed())].sort(), [...daysToKeep(days)].sort());
  assert.equal(daysToKeep(days).size, 11);
});

test('restoring a snapshot over the database brings back exactly the snapshot state', () => {
  const dir = tempDir();
  const file = join(tempDir(), 'subfeed.db');
  const live = openDb(file);
  live.subscribeChannel({ id: A, name: 'Alpha' }, []);
  live.upsertVideos([feedVideo({ id: 'vid00000001', channelId: A, title: 'one', published: '2026-11-01T00:00:00.000Z', views: 1, durationS: 60 })]);
  live.setFavorite('vid00000001', true);
  assert.ok(statSync(`${file}-wal`).size > 0, 'the writes are still in the WAL');
  const { file: snapshot } = runBackup(live, { now: at('2026-11-15'), dir });

  live.subscribeChannel({ id: B, name: 'Beta' }, []);
  live.setFavorite('vid00000001', false);
  live.close();

  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  copyFileSync(snapshot, file);
  const restored = openDb(file);
  assert.deepEqual(restored.listChannels().map((c) => c.id), [A]);
  const [video] = restored.listVideos({ channelIds: [A], shorts: 'include', favoritesOnly: false, limit: 10 }).videos;
  assert.deepEqual([video.id, video.durationS, video.favorite], ['vid00000001', 60, true]);
  restored.close();

  const exported = parseChannelsFile(readFileSync(join(dir, 'channels-2026-11-15.json'), 'utf8'));
  assert.deepEqual(exported.channels.map((c) => c.id), [A]);
});

test('a failed backup is logged and reported once per check, leaving no partial file', async () => {
  const dir = tempDir();
  const failures = [];
  const broken = { snapshot: () => { throw new Error('disk full'); }, listTopics: () => [], listChannels: () => [] };
  const stop = scheduleBackups(broken, { dir, firstDelayMs: 0, onFailure: (err) => failures.push(err.message) });
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.deepEqual(failures, ['disk full']);
  assert.deepEqual(readdirSync(dir), []);
  assert.ok(existsSync(dir));
});

test('a run deletes the partial snapshots that earlier days left behind, and the channels file holds the rules', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'subfeed-2026-11-10.db.partial'), 'half');
  writeFileSync(join(dir, 'notes.partial'), 'not ours');
  const db = openDb(':memory:');
  db.subscribeChannel({ id: A, name: 'Alpha' }, []);
  db.addRule({ kind: 'mute', pattern: 'live' });
  db.addRule({ kind: 'mute', pattern: 'trailer', channelId: A });
  runBackup(db, { now: at('2026-11-15'), dir });
  assert.deepEqual(readdirSync(dir).sort(), ['channels-2026-11-15.json', 'notes.partial', 'subfeed-2026-11-15.db']);
  const { rules } = parseChannelsFile(readFileSync(join(dir, 'channels-2026-11-15.json'), 'utf8'));
  assert.deepEqual(rules, [
    { kind: 'mute', pattern: 'live', channelId: null, topicId: null },
    { kind: 'mute', pattern: 'trailer', channelId: A, topicId: null },
  ]);
});

// Dropping a cell from a leaf page's count leaves a file that opens and reads, but fails quick_check.
const writeDamagedDb = (file) => {
  const d = new DatabaseSync(file);
  d.exec("CREATE TABLE t (x); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) INSERT INTO t SELECT printf('%0100d', i) FROM n");
  d.close();
  const bytes = readFileSync(file);
  const leaf = 3 * 4096;
  bytes.writeUInt16BE(bytes.readUInt16BE(leaf + 3) - 1, leaf + 3);
  writeFileSync(file, bytes);
};

test('a snapshot that fails quick_check fails the run and leaves neither the snapshot nor its partial', () => {
  const dir = tempDir();
  const damaged = { snapshot: writeDamagedDb, listTopics: () => [], listChannels: () => [], listRules: () => [] };
  assert.throws(() => runBackup(damaged, { now: at('2026-11-15'), dir }), /snapshot failed quick_check: .*Fragmentation/s);
  assert.deepEqual(readdirSync(dir), []);
});

test('an optimize run that finds the database locked is logged and the process keeps running', async (t) => {
  const file = join(tempDir(), 'subfeed.db');
  const db = openDb(file);
  db.subscribeChannel({ id: A, name: 'Channel A', handle: '@cha' }, []);
  const other = new DatabaseSync(file);
  other.exec('BEGIN EXCLUSIVE');
  const { promise: failed, resolve } = Promise.withResolvers();
  const logged = t.mock.method(console, 'error', resolve);
  const stop = scheduleOptimize(db, { everyMs: 1 });
  await failed;
  stop();
  other.exec('ROLLBACK');
  other.close();
  db.close();
  assert.equal(logged.mock.callCount(), 1);
  assert.match(logged.mock.calls[0].arguments[0], /^optimize failed: database is locked/);
});
