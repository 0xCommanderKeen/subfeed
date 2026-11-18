import assert from 'node:assert/strict';
import { test } from 'node:test';
import { videoDetails } from '../src/backfill.mjs';
import { openDb } from '../src/db.mjs';
import { bucketOf, buildGroups, groupHasNew, groupSize, latestVisible, visibleCount } from '../public/groups.js';
import { feedVideo } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const day = (n) => new Date(Date.UTC(2025, 0, 1 + n)).toISOString();

// A: a regular upload, a Short, an upcoming premiere, a live stream, a stream replay, a video not looked up yet and a
// live stream that came in through the Shorts feed. B: only an upcoming premiere. Every title holds "marathon".
const VIDEOS = [
  ['regular0001', A, 1, { kind: 'video', durationS: 600 }],
  ['short000001', A, 2, { kind: 'short', durationS: 40, isShort: true }],
  ['upcoming001', A, 6, { kind: 'upcoming' }],
  ['livenow0001', A, 5, { kind: 'live' }],
  ['replay00001', A, 4, { kind: 'stream_replay', durationS: 3 * 3600 }],
  ['unknown0001', A, 3, {}],
  ['liveshort01', A, 8, { kind: 'live', isShort: true }],
  ['upcoming002', B, 7, { kind: 'upcoming' }],
];
const STREAMS = new Set(['upcoming001', 'livenow0001', 'upcoming002']);

function fixture() {
  const db = openDb(':memory:');
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.subscribeChannel({ id: B, name: 'B' }, []);
  db.upsertVideos(VIDEOS.map(([id, channelId, d, extra]) => feedVideo({ id, channelId, title: `${id} marathon`, published: day(d), ...extra })));
  return db;
}

const BASE = { channelIds: [A, B], shorts: 'include', favoritesOnly: false, limit: 200 };
const ids = (videos) => videos.map((v) => v.id).sort();
const all = VIDEOS.map(([id]) => id).sort();
const withoutStreams = all.filter((id) => !STREAMS.has(id));

test('Hide streams leaves live and upcoming videos out of Feed and search, and keeps replays and unknown kinds', () => {
  const db = fixture();
  assert.deepEqual(ids(db.listVideos(BASE).videos), all);
  assert.deepEqual(ids(db.listVideos({ ...BASE, streams: 'include' }).videos), all);
  assert.deepEqual(ids(db.listVideos({ ...BASE, streams: 'exclude' }).videos), withoutStreams);
  assert.deepEqual(ids(db.listVideos({ ...BASE, streams: 'exclude', shorts: 'exclude' }).videos), ['regular0001', 'replay00001', 'unknown0001']);
  assert.deepEqual(ids(db.searchPage({ ...BASE, streams: 'exclude', q: 'marathon' }).videos), withoutStreams);
  assert.equal(db.searchPage({ ...BASE, streams: 'exclude', q: 'marathon' }).total, withoutStreams.length);
  assert.equal(db.searchPage({ ...BASE, q: 'marathon' }).total, all.length);
});

test('Hide streams applies to Shelves, so a channel of only streams becomes quiet', () => {
  const db = fixture();
  const shelves = (streams) => db.listShelfPage({ ...BASE, streams, perChannel: 12, channels: 10 }).shelves.map((s) => [s.channelId, ids(s.videos)]);
  assert.deepEqual(shelves('include'), [[A, all.filter((id) => id !== 'upcoming002')], [B, ['upcoming002']]]);
  assert.deepEqual(shelves('exclude'), [[A, withoutStreams]]);
});

test('Hide streams applies to the Watch Later queue', () => {
  const db = fixture();
  for (const id of ['regular0001', 'upcoming001', 'replay00001']) db.enqueue(id);
  assert.deepEqual(db.listQueue().map((v) => v.id), ['regular0001', 'upcoming001', 'replay00001']);
  assert.deepEqual(db.listQueue({ streams: 'exclude' }).map((v) => v.id), ['regular0001', 'replay00001']);
});

test('channelStats counts streams apart from long videos and Shorts', () => {
  const db = fixture();
  db.setFavorite('replay00001', true);
  db.setFavorite('regular0001', true);
  db.enqueue('upcoming001');
  const a = db.channelStats().get(A);
  assert.deepEqual(a.counts, { long: 3, short: 2, stream: 2 });
  assert.deepEqual(a.latest, { long: day(4), short: day(8), stream: day(6) });
  assert.deepEqual(a.starred, { long: 2, short: 0, stream: 0 });
  assert.deepEqual(a.queued, { long: 0, short: 0, stream: 1 });
  assert.deepEqual(db.channelStats().get(B).counts, { long: 0, short: 0, stream: 1 });
});

test('the counts match the listed videos for every Hide Shorts and Hide streams setting', () => {
  const db = fixture();
  const stats = db.channelStats();
  for (const shorts of ['include', 'exclude']) {
    for (const streams of ['include', 'exclude']) {
      for (const channelId of [A, B]) {
        const listed = db.listVideos({ ...BASE, channelIds: [channelId], shorts, streams }).videos;
        const counted = visibleCount(stats.get(channelId).counts, shorts === 'exclude', streams === 'exclude');
        assert.equal(listed.length, counted, `${channelId} shorts=${shorts} streams=${streams}`);
      }
    }
  }
  const buckets = { long: 0, short: 0, stream: 0 };
  for (const v of db.listVideos({ ...BASE, channelIds: [A] }).videos) buckets[bucketOf(v)] += 1;
  assert.deepEqual(buckets, stats.get(A).counts);
});

test('an upcoming premiere cannot be marked watched; once it has aired it becomes a normal video', () => {
  const db = fixture();
  db.markWatched(['upcoming001', 'regular0001']);
  assert.equal(db.getVideo('upcoming001').watched, false);
  assert.equal(db.getVideo('regular0001').watched, true);
  assert.ok(db.videosMissingDetails({ unavailableSince: day(0), limit: 100 }).some((v) => v.id === 'upcoming001'));

  const aired = {
    id: 'upcoming001',
    contentDetails: { duration: 'PT30M' },
    statistics: { viewCount: '10' },
    snippet: { liveBroadcastContent: 'none' },
    liveStreamingDetails: { scheduledStartTime: day(6), actualStartTime: day(6), actualEndTime: day(6) },
  };
  db.applyDetails([{ id: 'upcoming001', ...videoDetails(aired, false) }]);
  const v = db.getVideo('upcoming001');
  assert.deepEqual([v.kind, v.durationS], ['stream_replay', 1800]);
  assert.ok(ids(db.listVideos({ ...BASE, streams: 'exclude' }).videos).includes('upcoming001'));
  assert.deepEqual(db.channelStats().get(A).counts, { long: 4, short: 2, stream: 1 });
  db.markWatched(['upcoming001']);
  assert.equal(db.getVideo('upcoming001').watched, true);
});

test('the sidebar counts and new dots follow Hide streams', () => {
  const counts = { long: 5, short: 2, stream: 3 };
  assert.equal(visibleCount(counts, true), 8);
  assert.equal(visibleCount(counts, true, true), 5);
  assert.equal(visibleCount(counts, false, true), 7);
  const c = { id: 'a', topics: [], favorite: false, counts, latest: { long: '2025-01-01', short: '2025-02-01', stream: '2025-03-01' }, inTopic: {} };
  assert.equal(latestVisible(c, true), '2025-03-01');
  assert.equal(latestVisible(c, true, true), '2025-01-01');
  assert.equal(latestVisible(c, false, true), '2025-02-01');
  const meta = { topics: [], channels: [c], visits: { all: '2025-01-15' } };
  const everything = buildGroups(meta).find((g) => g.id === 'all');
  assert.equal(groupSize(everything, meta, { hideShorts: true, hideStreams: true }), 5);
  assert.equal(groupHasNew(everything, meta, { hideShorts: true }), true);
  assert.equal(groupHasNew(everything, meta, { hideShorts: true, hideStreams: true }), false);
  assert.deepEqual(['video', 'upcoming', 'live', 'stream_replay', null].map((kind) => bucketOf({ isShort: false, kind })), ['long', 'stream', 'stream', 'long', 'long']);
  assert.deepEqual(['short', 'live', 'upcoming'].map((kind) => bucketOf({ isShort: true, kind })), ['short', 'short', 'short']);
});
