import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, topicGroup } from '../src/db.mjs';
import { feedVideo } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const C = 'UCcccccccccccccccccccccc';
const D = 'UCdddddddddddddddddddddd';
const ALL = [A, B, C, D];

const day = (n, hour = 0) => new Date(Date.UTC(2025, 0, 1 + n, hour)).toISOString();
// A: 20 videos, every third a Short. Days 10 to 14 hold two videos each, so a cap of 7 cuts
// inside a run of equal publish times.
// B: 3 long videos, newest on day 30, so B's shelf comes first.
// C: unsubscribed, newest of all on day 40.
// D: Shorts only.
function fixture() {
  const db = openDb(':memory:');
  for (const id of ALL) db.subscribeChannel({ id, name: id }, []);
  db.updateChannel(C, { subscribed: false });
  const videos = [
    ...Array.from({ length: 20 }, (_, i) => feedVideo({ id: `a${String(i).padStart(10, '0')}`, channelId: A, published: day(i < 10 ? i : 10 + Math.floor((i - 10) / 2)), isShort: i % 3 === 0 })),
    ...[28, 29, 30].map((d, i) => feedVideo({ id: `b${String(i).padStart(10, '0')}`, channelId: B, published: day(d) })),
    feedVideo({ id: 'c0000000000', channelId: C, published: day(40) }),
    ...[5, 6].map((d, i) => feedVideo({ id: `d${String(i).padStart(10, '0')}`, channelId: D, published: day(d), isShort: true })),
  ];
  db.upsertVideos(videos);
  return { db, videos };
}

// The expectation is computed independently of SQL: filter, sort by (published, id) descending, take N.
function expected(videos, { channelIds, shorts, perChannel, subscribed }) {
  const keep = (v) => channelIds.includes(v.channelId) && subscribed.includes(v.channelId) && (shorts === 'include' || v.isShort === (shorts === 'only'));
  const byChannel = Map.groupBy(videos.filter(keep), (v) => v.channelId);
  return [...byChannel]
    .map(([channelId, list]) => {
      const sorted = list.toSorted((x, y) => (y.published + y.id).localeCompare(x.published + x.id));
      return { channelId, latest: sorted[0].published, ids: sorted.slice(0, perChannel).map((v) => v.id) };
    })
    .sort((x, y) => y.latest.localeCompare(x.latest) || x.channelId.localeCompare(y.channelId));
}

const shape = (shelves) => shelves.map((s) => ({ channelId: s.channelId, latest: s.latest, ids: s.videos.map((v) => v.id) }));

test('shelves match an independent sort for every cap and Shorts mode', () => {
  const { db, videos } = fixture();
  for (const shorts of ['include', 'exclude', 'only']) {
    for (const perChannel of [1, 2, 7, 12, 50]) {
      const got = db.listShelves({ channelIds: ALL, shorts, favoritesOnly: false, perChannel });
      assert.deepEqual(shape(got), expected(videos, { channelIds: ALL, shorts, perChannel, subscribed: [A, B, D] }), `${shorts}, ${perChannel} per channel`);
    }
  }
});

test('shelves are ordered by latest upload and capped per channel', () => {
  const { db } = fixture();
  const shelves = db.listShelves({ channelIds: ALL, shorts: 'include', favoritesOnly: false, perChannel: 12 });
  assert.deepEqual(shelves.map((s) => s.channelId), [B, A, D]);
  assert.deepEqual(shelves.map((s) => s.videos.length), [3, 12, 2]);
  assert.equal(shelves[1].latest, shelves[1].videos[0].published);
});

test('hiding Shorts drops Shorts-only channels and refills the cap with long videos', () => {
  const { db } = fixture();
  const shelves = db.listShelves({ channelIds: ALL, shorts: 'exclude', favoritesOnly: false, perChannel: 12 });
  assert.deepEqual(shelves.map((s) => s.channelId), [B, A]);
  assert.equal(shelves[1].videos.length, 12);
  assert.ok(shelves.flatMap((s) => s.videos).every((v) => !v.isShort));
});

test('an unsubscribed channel has no shelf even when asked for by id', () => {
  const { db } = fixture();
  assert.deepEqual(db.listShelves({ channelIds: [C], shorts: 'include', favoritesOnly: false, perChannel: 12 }), []);
  db.updateChannel(C, { subscribed: true });
  assert.deepEqual(db.listShelves({ channelIds: [C], shorts: 'include', favoritesOnly: false, perChannel: 12 }).map((s) => s.channelId), [C]);
});

test('favorites-only shelves hold just the starred videos, with their flags', () => {
  const { db } = fixture();
  db.setFavorite('a0000000002', true);
  db.setFavorite('b0000000000', true);
  db.markWatched(['b0000000000']);
  const shelves = db.listShelves({ channelIds: ALL, shorts: 'include', favoritesOnly: true, perChannel: 12 });
  assert.deepEqual(shape(shelves).map((s) => [s.channelId, s.ids]), [[B, ['b0000000000']], [A, ['a0000000002']]]);
  assert.deepEqual(shelves.map((s) => [s.videos[0].favorite, s.videos[0].watched]), [[true, true], [true, false]]);
});

test('queued-only shelves hold just the queued videos, in the channel order of the queued ones', () => {
  const { db } = fixture();
  db.enqueue('a0000000002');
  db.enqueue('b0000000000');
  const page = db.listShelfPage({ channelIds: ALL, shorts: 'include', favoritesOnly: false, queuedOnly: true, perChannel: 12, channels: 10 });
  assert.deepEqual(shape(page.shelves).map((s) => [s.channelId, s.ids]), [[B, ['b0000000000']], [A, ['a0000000002']]]);
});

test('a visit reported from a fast clock is stored as the server time', () => {
  const db = openDb(':memory:', { now: () => new Date('2025-03-02T10:00:00.000Z') });
  db.markVisit('all', '2025-03-02T11:00:00.000Z');
  assert.equal(db.listVisits().all, '2025-03-02T10:00:00.000Z');
});

test('visits keep the latest time per group, whatever order they arrive in', () => {
  const db = openDb(':memory:');
  assert.deepEqual(db.listVisits(), {});
  db.markVisit('all', '2025-03-02T10:00:00.000Z');
  db.markVisit('all', '2025-03-01T10:00:00.000Z');
  db.markVisit('favorite-channels', '2025-03-01T10:00:00.000Z');
  assert.deepEqual(db.listVisits(), { all: '2025-03-02T10:00:00.000Z', 'favorite-channels': '2025-03-01T10:00:00.000Z' });
  db.markVisit('all', '2025-03-03T10:00:00.000Z');
  assert.equal(db.listVisits().all, '2025-03-03T10:00:00.000Z');
});

test('deleting a topic forgets its visit and keeps the others', () => {
  const db = openDb(':memory:');
  const topic = db.createTopic('Printing');
  db.markVisit(topicGroup(topic.id), '2025-03-02T10:00:00.000Z');
  db.markVisit('all', '2025-03-02T10:00:00.000Z');
  db.deleteTopic(topic.id);
  assert.deepEqual(db.listVisits(), { all: '2025-03-02T10:00:00.000Z' });
});

test('walking shelf pages of every size gives the same shelves as one request, for every filter', () => {
  const { db } = fixture();
  for (const shorts of ['include', 'exclude', 'only']) {
    const filters = { channelIds: ALL, shorts, favoritesOnly: false, perChannel: 7 };
    const whole = shape(db.listShelves(filters));
    for (const channels of [1, 2, 3, 10]) {
      const walked = [];
      let after = null;
      let calls = 0;
      do {
        const page = db.listShelfPage({ ...filters, channels, after });
        assert.ok(page.shelves.length <= channels);
        walked.push(...page.shelves);
        after = page.next;
        assert.ok(++calls <= whole.length + 1, 'paging terminates');
      } while (after);
      assert.deepEqual(shape(walked), whole, `${shorts}, ${channels} per page`);
    }
  }
});

test('the last shelf page has no next cursor, and a page past the end is empty', () => {
  const { db } = fixture();
  const filters = { channelIds: ALL, shorts: 'include', favoritesOnly: false, perChannel: 12 };
  const all = db.listShelfPage({ ...filters, channels: 3 });
  assert.deepEqual(all.shelves.map((s) => s.channelId), [B, A, D]);
  assert.equal(all.next, null);
  const d = all.shelves.at(-1);
  assert.deepEqual(db.listShelfPage({ ...filters, channels: 3, after: { latest: d.latest, channelId: D } }), { shelves: [], next: null });
});
