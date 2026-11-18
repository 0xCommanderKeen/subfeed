import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { buildGroups, groupHasNew, groupSize, shownTallies, visibleCount } from '../public/groups.js';
import { feedVideo } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const day = (n) => new Date(Date.UTC(2025, 0, 1 + n)).toISOString();

// A: long videos, a Short and a live stream; B: one long video. Every title holds "lathe".
const VIDEOS = [
  ['long0000001', A, 1, { kind: 'video' }],
  ['long0000002', A, 2, { kind: 'video' }],
  ['long0000003', A, 3, { kind: 'video' }],
  ['short000001', A, 4, { kind: 'short', isShort: true }],
  ['livenow0001', A, 5, { kind: 'live' }],
  ['bvideo00001', B, 6, { kind: 'video' }],
];
const WATCHED = ['long0000003', 'short000001', 'livenow0001', 'bvideo00001'];

function fixture() {
  const db = openDb(':memory:');
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.subscribeChannel({ id: B, name: 'B' }, []);
  db.upsertVideos(VIDEOS.map(([id, channelId, d, extra]) => feedVideo({ id, channelId, title: `${id} lathe`, published: day(d), ...extra })));
  db.markWatched(WATCHED);
  db.setFavorite('long0000001', true);
  db.setFavorite('long0000003', true);
  db.enqueue('long0000003');
  return db;
}

const BASE = { channelIds: [A, B], shorts: 'include', favoritesOnly: false, limit: 200 };
const ids = (videos) => videos.map((v) => v.id).sort();

test('a watched video can be marked unwatched, and marked watched again', () => {
  const db = fixture();
  db.markUnwatched('long0000003');
  assert.equal(db.getVideo('long0000003').watched, false);
  db.markUnwatched('long0000003');
  assert.equal(db.getVideo('long0000003').watched, false, 'unmarking twice is harmless');
  db.markWatched(['long0000003']);
  assert.equal(db.getVideo('long0000003').watched, true);
});

test('Hide watched leaves watched videos out of Feed, search, starred videos and Shelves', () => {
  const db = fixture();
  assert.deepEqual(ids(db.listVideos(BASE).videos), ids(VIDEOS.map(([id]) => ({ id }))));
  assert.deepEqual(ids(db.listVideos({ ...BASE, watched: 'exclude' }).videos), ['long0000001', 'long0000002']);
  assert.deepEqual(ids(db.searchPage({ ...BASE, watched: 'exclude', q: 'lathe' }).videos), ['long0000001', 'long0000002']);
  assert.equal(db.searchPage({ ...BASE, watched: 'exclude', q: 'lathe' }).total, 2);
  assert.deepEqual(ids(db.listVideos({ ...BASE, watched: 'exclude', favoritesOnly: true }).videos), ['long0000001']);
  const shelves = (watched) => db.listShelfPage({ ...BASE, watched, perChannel: 12, channels: 10 }).shelves.map((s) => [s.channelId, ids(s.videos)]);
  assert.deepEqual(shelves('exclude'), [[A, ['long0000001', 'long0000002']]], 'B has only watched videos, so it is quiet');
  assert.equal(shelves('include').length, 2);
});

test('the unwatched counts match the listed videos for every filter', () => {
  const db = fixture();
  const stats = db.channelStats();
  for (const shorts of ['include', 'exclude']) {
    for (const streams of ['include', 'exclude']) {
      for (const watched of ['include', 'exclude']) {
        for (const channelId of [A, B]) {
          const tallies = shownTallies(stats.get(channelId), watched === 'exclude');
          const filters = { ...BASE, channelIds: [channelId], shorts, streams, watched };
          const label = `${channelId} shorts=${shorts} streams=${streams} watched=${watched}`;
          assert.equal(db.listVideos(filters).videos.length, visibleCount(tallies.counts, shorts === 'exclude', streams === 'exclude'), label);
          assert.equal(db.listVideos({ ...filters, favoritesOnly: true }).videos.length, visibleCount(tallies.starred, shorts === 'exclude', streams === 'exclude'), `starred ${label}`);
        }
      }
    }
  }
  assert.deepEqual(stats.get(A).unwatched.latest, { long: day(2), short: null, stream: null });
  assert.deepEqual(stats.get(B).unwatched.counts, { long: 0, short: 0, stream: 0 });
});

test('the sidebar counts and new dots follow Hide watched, and Watch Later keeps its watched videos', () => {
  const db = fixture();
  const stats = db.channelStats();
  const meta = {
    topics: [],
    channels: [{ id: A, topics: [], favorite: false, ...stats.get(A) }, { id: B, topics: [], favorite: false, ...stats.get(B) }],
    visits: { all: day(2) },
  };
  const groups = buildGroups(meta);
  const group = (id) => groups.find((g) => g.id === id);
  assert.equal(groupSize(group('all'), meta, {}), 6);
  assert.equal(groupSize(group('all'), meta, { hideWatched: true }), 2);
  assert.equal(groupSize(group('favorites'), meta, { hideWatched: true }), 1);
  assert.equal(groupSize(group('watch-later'), meta, { hideWatched: true }), 1, 'the queued video is watched but stays counted');
  assert.equal(groupHasNew(group('all'), meta, {}), true);
  assert.equal(groupHasNew(group('all'), meta, { hideWatched: true }), false, 'every video after the visit is watched');
});

test('the unwatched counts follow marking watched and unwatched, though channelStats is cached', () => {
  const db = fixture();
  const unwatchedLong = () => db.channelStats().get(A).unwatched.counts.long;
  assert.equal(unwatchedLong(), 2);
  db.markWatched(['long0000001']);
  assert.equal(unwatchedLong(), 1);
  db.markUnwatched('long0000001');
  db.markUnwatched('long0000003');
  assert.equal(unwatchedLong(), 3);
});
