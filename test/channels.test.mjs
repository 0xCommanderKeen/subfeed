import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportChannels, openSeededDb, parseChannelsFile } from '../src/channels-file.mjs';
import { openDb, slugify } from '../src/db.mjs';
import { feedVideo } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const C = 'UCcccccccccccccccccccccc';
const EXAMPLE_FILE = readFileSync(join(import.meta.dirname, '..', 'channels.example.json'), 'utf8');

const SEED = {
  topics: [{ id: 'print', name: 'Printing' }, { id: 'paint', name: 'Painting' }, { id: 'games', name: 'Games' }],
  channels: [
    { id: A, name: 'Alpha', handle: '@alpha', topics: ['print'] },
    { id: B, name: 'Beta', handle: '@beta', topics: ['paint', 'print'] },
    { id: C, name: 'Gamma', handle: null, topics: [], subscribed: false, favorite: true },
  ],
};

const seeded = () => {
  const db = openDb(':memory:');
  db.seedChannels(() => SEED);
  return db;
};

const allVideos = (db) =>
  db.listVideos({ channelIds: [A, B, C], shorts: 'include', favoritesOnly: false, limit: 200 }).videos.map((v) => v.id).sort();

const summary = (db) => ({
  topics: db.listTopics().map(({ id, name, hidden }) => ({ id, name, hidden })),
  channels: db.listChannels().map(({ id, name, handle, topics, subscribed, favorite }) => ({ id, name, handle, topics, subscribed, favorite })),
});

test('seeding imports topics in order and channel memberships once', () => {
  const db = openDb(':memory:');
  let loads = 0;
  const load = () => (loads++, SEED);
  assert.equal(db.seedChannels(load), true);
  assert.deepEqual(db.listTopics().map((t) => [t.id, t.position]), [['print', 0], ['paint', 1], ['games', 2]]);
  assert.deepEqual(summary(db).channels, [
    { id: A, name: 'Alpha', handle: '@alpha', topics: ['print'], subscribed: true, favorite: false },
    { id: B, name: 'Beta', handle: '@beta', topics: ['paint', 'print'], subscribed: true, favorite: false },
    { id: C, name: 'Gamma', handle: null, topics: [], subscribed: false, favorite: true },
  ]);

  assert.equal(db.seedChannels(load), false, 'second start does not re-import');
  for (const id of [A, B, C]) db.deleteChannel(id);
  assert.equal(db.seedChannels(load), false, 'deleting every channel does not bring the seed back');
  assert.equal(loads, 1);
  assert.deepEqual(db.listChannels(), []);
});

test('channels.example.json survives parse, seed, export byte for byte', () => {
  const db = openDb(':memory:');
  db.seedChannels(() => parseChannelsFile(EXAMPLE_FILE));
  assert.equal(exportChannels(db), EXAMPLE_FILE);
});

test('without a channels.json the database starts empty, and a channels.json added later still seeds it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'subfeed-seed-'));
  const file = join(dir, 'subfeed.db');
  const seedPath = join(dir, 'channels.json');
  try {
    const empty = openSeededDb(file, seedPath);
    assert.deepEqual([empty.listTopics(), empty.listChannels()], [[], []]);
    empty.close();
    writeFileSync(seedPath, EXAMPLE_FILE);
    const seeded = openSeededDb(file, seedPath);
    assert.equal(seeded.listChannels().length, 4);
    seeded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export keeps unsubscribed, favorite and hidden-topic flags, and a fresh database seeded from it is identical', () => {
  const db = seeded();
  db.updateChannel(A, { favorite: true });
  db.updateChannel(B, { subscribed: false });
  db.updateTopic('games', { hidden: true });
  db.updateTopic('paint', { hidden: true });
  const exported = exportChannels(db);
  assert.match(exported, /"favorite": true/);
  assert.match(exported, /"subscribed": false/);
  assert.match(exported, /\n  "hiddenTopics": \["paint", "games"\],\n/);
  const fresh = openDb(':memory:');
  fresh.seedChannels(() => parseChannelsFile(exported));
  assert.deepEqual(summary(fresh), summary(db));
});

test('export keeps the mute and route rules, and a fresh database seeded from it has the same rules', () => {
  const db = seeded();
  db.addRule({ kind: 'mute', pattern: 'Weekly Q&A', topicId: 'paint' });
  db.addRule({ kind: 'route', pattern: 'Paint Table', channelId: B, topicId: 'paint' });
  const exported = exportChannels(db);
  assert.match(exported, /\n  "rules": \[\n    \{ "kind": "mute", "pattern": "Weekly Q&A", "topic": "paint" \},\n    \{ "kind": "route", /);
  const fresh = openDb(':memory:');
  fresh.seedChannels(() => parseChannelsFile(exported));
  const rules = (d) => d.listRules().map(({ id, ...r }) => r);
  assert.equal(rules(fresh).length, 2);
  assert.deepEqual(rules(fresh), rules(db));
});

test('a channels file without rules still loads, with no rules', () => {
  const { rules, ...old } = JSON.parse(EXAMPLE_FILE);
  assert.equal(rules.length, 2);
  const db = openDb(':memory:');
  db.seedChannels(() => parseChannelsFile(JSON.stringify(old)));
  assert.equal(db.listChannels().length, 4);
  assert.deepEqual(db.listRules(), []);
});

test('parseChannelsFile rejects a rule with an unknown channel or topic, and a route rule without both', () => {
  const file = (rule) => JSON.stringify({ topics: { a: 'A' }, channels: [{ id: A, name: 'Alpha', topics: ['a'] }], rules: [rule] });
  assert.throws(() => parseChannelsFile(file({ kind: 'mute', pattern: 'x', channel: B })), /unknown channel/);
  assert.throws(() => parseChannelsFile(file({ kind: 'mute', pattern: 'x', topic: 'nope' })), /unknown topic nope/);
  assert.throws(() => parseChannelsFile(file({ kind: 'route', pattern: 'x', channel: A })), /needs a channel and a topic/);
  assert.throws(() => parseChannelsFile(file({ kind: 'hide', pattern: 'x' })), /needs kind/);
  assert.throws(() => parseChannelsFile(file({ kind: 'mute', pattern: '!!' })), /needs a pattern with a word/);
});

test('parseChannelsFile rejects a hidden topic that is not in topics', () => {
  const bad = JSON.stringify({ topics: { a: 'A' }, hiddenTopics: ['nope'], channels: [] });
  assert.throws(() => parseChannelsFile(bad), /hiddenTopics lists unknown topic nope/);
  assert.throws(() => parseChannelsFile(JSON.stringify({ topics: { a: 'A' }, hiddenTopics: 'a', channels: [] })), /hiddenTopics needs to be an array/);
});

test('parseChannelsFile rejects a channel that uses an unknown topic', () => {
  const bad = JSON.stringify({ topics: { a: 'A' }, channels: [{ id: A, name: 'Alpha', topics: ['nope'] }] });
  assert.throws(() => parseChannelsFile(bad), /unknown topic nope/);
});

test('subscribeChannel on a known channel resubscribes it and merges topics', () => {
  const db = seeded();
  assert.deepEqual(db.subscribeChannel({ id: C, name: 'Gamma renamed', handle: '@gamma' }, ['games', 'print']), { created: false });
  assert.deepEqual(summary(db).channels[2], { id: C, name: 'Gamma renamed', handle: '@gamma', topics: ['games', 'print'], subscribed: true, favorite: true });
  assert.deepEqual(db.subscribeChannel({ id: 'UCdddddddddddddddddddddd', name: 'Delta', handle: null }, ['games']), { created: true });
});

test('updateChannel replaces topics, keeping the order of links that stay', () => {
  const db = seeded();
  assert.deepEqual(db.updateChannel(B, { topics: ['games', 'print'] }), { wasSubscribed: true });
  assert.deepEqual(db.listChannels()[1].topics, ['print', 'games']);
  assert.equal(db.updateChannel('UCzzzzzzzzzzzzzzzzzzzzzz', { favorite: true }), null);
});

test('setTopicOnChannels links or unlinks one topic on many channels and counts only real changes', () => {
  const db = seeded();
  const topicsOf = () => Object.fromEntries(db.listChannels().map((c) => [c.name, c.topics]));
  assert.equal(db.setTopicOnChannels('print', [A, B, C], true), 1, 'only Gamma lacked print');
  assert.equal(db.setTopicOnChannels('games', [A, C], true), 2);
  assert.deepEqual(topicsOf(), { Alpha: ['print', 'games'], Beta: ['paint', 'print'], Gamma: ['print', 'games'] });
  assert.equal(db.setTopicOnChannels('print', [A, B], false), 2);
  assert.equal(db.setTopicOnChannels('paint', [A], false), 0, 'Alpha never had paint');
  assert.deepEqual(topicsOf(), { Alpha: ['games'], Beta: ['paint'], Gamma: ['print', 'games'] });
});

test('deleteChannel removes its videos, favorites, watched rows and links, and nothing of other channels', () => {
  const db = seeded();
  db.upsertVideos([feedVideo({ id: 'aaaaaaaaaa1', channelId: A }), feedVideo({ id: 'aaaaaaaaaa2', channelId: A }), feedVideo({ id: 'bbbbbbbbbb1', channelId: B })]);
  db.setFavorite('aaaaaaaaaa1', true);
  db.setFavorite('bbbbbbbbbb1', true);
  db.markWatched(['aaaaaaaaaa2', 'bbbbbbbbbb1']);
  assert.equal(db.deleteChannel(A), true);
  assert.equal(db.deleteChannel(A), false);
  assert.deepEqual(allVideos(db), ['bbbbbbbbbb1']);
  assert.deepEqual(db.listChannels().map((c) => c.id), [B, C]);
  const [b] = db.listVideos({ channelIds: [B], shorts: 'include', favoritesOnly: true, limit: 10 }).videos;
  assert.deepEqual([b.favorite, b.watched], [true, true]);

  db.subscribeChannel({ id: A, name: 'Alpha again' }, []);
  assert.deepEqual(db.listVideos({ channelIds: [A], shorts: 'include', favoritesOnly: false, limit: 10 }).videos, [], 'no videos survive a re-add');
  db.upsertVideos([feedVideo({ id: 'aaaaaaaaaa1', channelId: A }), feedVideo({ id: 'aaaaaaaaaa2', channelId: A })]);
  const again = db.listVideos({ channelIds: [A], shorts: 'include', favoritesOnly: false, limit: 10 }).videos;
  assert.deepEqual(again.map((v) => [v.id, v.favorite, v.watched]), [['aaaaaaaaaa2', false, false], ['aaaaaaaaaa1', false, false]], 'refetched videos come back unstarred and unwatched');
});

test('videos of a channel that is not in the database are not stored', () => {
  const db = seeded();
  db.deleteChannel(A);
  db.upsertVideos([feedVideo({ id: 'aaaaaaaaaa1', channelId: A }), feedVideo({ id: 'bbbbbbbbbb1', channelId: B })]);
  assert.deepEqual(allVideos(db), ['bbbbbbbbbb1']);
});

test('topics: unique slug ids, rename, reorder, delete keeps channels', () => {
  const db = seeded();
  assert.deepEqual(db.createTopic('Printing'), { id: 'printing', name: 'Printing', position: 3, hidden: false });
  assert.equal(db.createTopic('Printing').id, 'printing-2');
  assert.equal(db.createTopic('Print').id, 'print-2', 'an existing id gets a suffix');
  assert.equal(slugify('Warhammer 40,000'), 'warhammer-40-000');
  assert.equal(slugify('Ça va'), 'ca-va');
  assert.equal(slugify('2024'), 't-2024', 'integer-like ids would reorder /api/meta topics');
  assert.equal(slugify('★★'), 'topic');

  assert.equal(db.updateTopic('paint', { name: 'Mini Painting', position: 0 }), true);
  assert.deepEqual(db.listTopics().slice(0, 3).map((t) => [t.id, t.name, t.position]), [['paint', 'Mini Painting', 0], ['print', 'Printing', 1], ['games', 'Games', 2]]);
  db.updateTopic('paint', { position: 99 });
  assert.equal(db.listTopics().at(-1).id, 'paint', 'a position past the end moves it last');
  assert.deepEqual(db.listTopics().map((t) => t.position), [0, 1, 2, 3, 4, 5]);
  assert.equal(db.updateTopic('nope', { name: 'x' }), false);

  assert.equal(db.deleteTopic('print'), true);
  assert.equal(db.listTopics().some((t) => t.id === 'print'), false);
  assert.equal(db.deleteTopic('print'), false);
  assert.deepEqual(db.listChannels().map((c) => [c.id, c.topics]), [[A, []], [B, ['paint']], [C, []]]);
});

test('hiding a topic keeps its place, its channels and its videos', () => {
  const db = seeded();
  assert.deepEqual(db.listTopics().map((t) => t.hidden), [false, false, false], 'topics start shown');
  assert.equal(db.updateTopic('paint', { hidden: true }), true);
  assert.deepEqual(db.listTopics().map((t) => [t.id, t.position, t.hidden]), [['print', 0, false], ['paint', 1, true], ['games', 2, false]]);
  db.updateTopic('paint', { position: 0 });
  assert.deepEqual(db.listTopics().map((t) => [t.id, t.hidden]), [['paint', true], ['print', false], ['games', false]], 'moving keeps the flag');
  assert.deepEqual(db.listChannels().find((c) => c.id === B).topics, ['paint', 'print']);
  db.upsertVideos([feedVideo({ id: 'bbbbbbbbbb1', channelId: B })]);
  assert.deepEqual(allVideos(db), ['bbbbbbbbbb1']);
  db.updateTopic('paint', { hidden: false });
  assert.equal(db.listTopics()[0].hidden, false);
});

test('an old database gains the hidden flag with every topic shown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'subfeed-'));
  try {
    const file = join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER); INSERT INTO topics VALUES ('print', 'Printing', 0)");
    old.close();
    const db = openDb(file);
    assert.deepEqual(db.listTopics(), [{ id: 'print', name: 'Printing', position: 0, hidden: false }]);
    db.updateTopic('print', { hidden: true });
    assert.equal(db.listTopics()[0].hidden, true);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export-channels.mjs reads the database SUBFEED_DB names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'subfeed-cli-'));
  const file = join(dir, 'subfeed.db');
  const out = join(dir, 'channels.json');
  try {
    const db = openDb(file);
    db.seedChannels(() => ({ topics: SEED.topics, channels: SEED.channels.slice(0, 1) }));
    db.close();
    execFileSync(process.execPath, ['bin/export-channels.mjs', out], { cwd: join(import.meta.dirname, '..'), env: { SUBFEED_DB: file } });
    assert.deepEqual(parseChannelsFile(readFileSync(out, 'utf8')).channels.map((c) => c.id), [A]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('add-channel.mjs refuses a topic that does not exist before it looks up the channel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'subfeed-cli-'));
  const file = join(dir, 'subfeed.db');
  try {
    const db = openDb(file);
    db.seedChannels(() => ({ topics: SEED.topics, channels: [] }));
    db.close();
    const run = spawnSync(process.execPath, ['bin/add-channel.mjs', A, 'print', 'robotics'], { cwd: join(import.meta.dirname, '..'), env: { SUBFEED_DB: file }, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, 'No topic "robotics". Topics: print, paint, games. Create one on the Manage page.\n');
    const after = openDb(file);
    assert.deepEqual([after.listTopics().length, after.listChannels()], [3, []]);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('add-channel.mjs takes a channel without topics, so it works on a database with none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'subfeed-cli-'));
  try {
    const run = spawnSync(process.execPath, ['bin/add-channel.mjs', 'not a channel'], { cwd: join(import.meta.dirname, '..'), env: { SUBFEED_DB: join(dir, 'subfeed.db') }, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^Not a channel: "not a channel"\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
