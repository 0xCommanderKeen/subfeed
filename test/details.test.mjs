import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillMissingDetails, parseDuration, videoDetails } from '../src/backfill.mjs';
import { ApiError, dbMeter, fetchApi, pacificDay } from '../src/youtube-api.mjs';
import { openDb } from '../src/db.mjs';
import { feedVideo } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';

const item = (id, { duration = 'PT10M', live = 'none', started = null, views = '5' } = {}) => ({
  id,
  contentDetails: { duration },
  statistics: { viewCount: views },
  snippet: { liveBroadcastContent: live },
  ...(started && { liveStreamingDetails: { actualStartTime: started, scheduledStartTime: started } }),
});

test('parseDuration handles hours, minutes, seconds, days and P0D', () => {
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT1H'), 3600);
  assert.equal(parseDuration('PT59S'), 59);
  assert.equal(parseDuration('P0D'), 0);
  assert.equal(parseDuration('P1DT1M'), 86460);
  assert.equal(parseDuration(''), null);
});

test('videoDetails derives kind from the live state and the uploads playlist', () => {
  assert.deepEqual(videoDetails(item('v', { duration: 'PT1H2M3S', views: '42' }), false), { durationS: 3723, views: 42, kind: 'video' });
  assert.deepEqual(videoDetails(item('v', { duration: 'PT45S' }), true), { durationS: 45, views: 5, kind: 'short' });
  assert.deepEqual(videoDetails(item('v', { duration: 'P0D', live: 'upcoming' }), false), { durationS: null, views: 5, kind: 'upcoming' });
  assert.deepEqual(videoDetails(item('v', { duration: 'P0D', live: 'live', started: '2026-11-15T10:00:00Z' }), false), { durationS: null, views: 5, kind: 'live' });
  assert.deepEqual(videoDetails(item('v', { duration: 'PT2H', started: '2026-11-14T10:00:00Z' }), false), { durationS: 7200, views: 5, kind: 'stream_replay' });
  assert.deepEqual(videoDetails(item('v', { duration: 'P0D' }), false), { durationS: 0, views: 5, kind: 'video' });
  assert.deepEqual(videoDetails(undefined, false), { durationS: null, views: null, kind: 'unavailable' });
});

const vid = (n) => `v${String(n).padStart(10, '0')}`;
const minute = (n) => new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString();
const NOW = '2026-11-15T00:00:00.000Z';

// Answers videos.list from `catalog` (id -> item); ids it lacks are left out, like deleted videos.
function fakeApi(catalog) {
  const calls = [];
  const api = async (endpoint, params) => {
    calls.push({ endpoint, ...params, ids: params.id.split(',') });
    return { items: params.id.split(',').filter((id) => catalog.has(id)).map((id) => catalog.get(id)) };
  };
  return { api, calls };
}

const durations = (db, channelIds = [A]) =>
  new Map(db.listVideos({ channelIds, shorts: 'include', favoritesOnly: false, limit: 200 }).videos.map((v) => [v.id, [v.durationS, v.kind]]));

test('fillMissingDetails fills the newest videos first, 50 per call, up to the call cap', async () => {
  const db = openDb(':memory:', { now: () => new Date(NOW) });
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.upsertVideos(Array.from({ length: 120 }, (_, n) => feedVideo({ id: vid(n), channelId: A, published: minute(n) })));
  const { api, calls } = fakeApi(new Map(Array.from({ length: 120 }, (_, n) => [vid(n), item(vid(n), { duration: 'PT3M' })])));

  assert.equal(await fillMissingDetails({ db, api, maxCalls: 2 }), 100);
  assert.deepEqual(calls.map((c) => [c.endpoint, c.part, c.ids.length]), [
    ['videos', 'contentDetails,statistics,liveStreamingDetails,snippet', 50],
    ['videos', 'contentDetails,statistics,liveStreamingDetails,snippet', 50],
  ]);
  const got = durations(db);
  assert.ok([...Array(100)].every((_, i) => got.get(vid(119 - i))[0] === 180), 'the newest 100 have a duration');
  assert.ok([...Array(20)].every((_, n) => got.get(vid(n))[0] === null), 'the oldest 20 wait for the next refresh');

  calls.length = 0;
  assert.equal(await fillMissingDetails({ db, api, maxCalls: 2 }), 20);
  assert.deepEqual(calls.map((c) => c.ids.length), [20]);
  calls.length = 0;
  assert.equal(await fillMissingDetails({ db, api, maxCalls: 2 }), 0);
  assert.equal(calls.length, 0, 'nothing left means no call');
});

test('live and upcoming videos are asked again; unavailable, known and unsubscribed ones are not', async () => {
  const db = openDb(':memory:', { now: () => new Date(NOW) });
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.subscribeChannel({ id: B, name: 'B' }, []);
  db.updateChannel(B, { subscribed: false });
  db.upsertVideos([
    feedVideo({ id: 'premiere001', channelId: A, published: minute(5) }),
    feedVideo({ id: 'deleted0001', channelId: A, published: minute(4) }),
    feedVideo({ id: 'known000001', channelId: A, published: minute(3), durationS: 600 }),
    feedVideo({ id: 'regular0001', channelId: A, published: minute(2) }),
    feedVideo({ id: 'elsewhere01', channelId: B, published: minute(1) }),
  ]);
  const catalog = new Map([
    ['premiere001', item('premiere001', { duration: 'P0D', live: 'upcoming' })],
    ['regular0001', item('regular0001', { duration: 'PT20M' })],
  ]);
  const { api, calls } = fakeApi(catalog);
  await fillMissingDetails({ db, api, maxCalls: 20 });
  assert.deepEqual(calls[0].ids, ['premiere001', 'deleted0001', 'regular0001']);
  assert.deepEqual(Object.fromEntries(durations(db)), {
    premiere001: [null, 'upcoming'], deleted0001: [null, 'unavailable'], known000001: [600, null], regular0001: [1200, 'video'],
  });

  catalog.set('premiere001', item('premiere001', { duration: 'PT31M', started: '2026-11-15T10:00:00Z' }));
  calls.length = 0;
  await fillMissingDetails({ db, api, maxCalls: 20 });
  assert.deepEqual(calls.map((c) => c.ids), [['premiere001']]);
  assert.deepEqual(durations(db).get('premiere001'), [1860, 'stream_replay']);
});

test('an RSS upsert keeps a known kind and duration', () => {
  const db = openDb(':memory:');
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.upsertVideos([feedVideo({ id: 'regular0001', channelId: A, published: minute(1), durationS: 1200, kind: 'video' })]);
  db.upsertVideos([feedVideo({ id: 'regular0001', channelId: A, published: minute(1), title: 'renamed' })]);
  assert.deepEqual(durations(db).get('regular0001'), [1200, 'video']);
});

test('length filters split at 15 and 45 minutes and drop unknown durations', () => {
  const db = openDb(':memory:');
  db.subscribeChannel({ id: A, name: 'A' }, []);
  const lengths = { s0: 0, s899: 899, s900: 900, s2700: 2700, s2701: 2701, unknown: null };
  db.upsertVideos(Object.entries(lengths).map(([id, durationS], i) => feedVideo({ id: id.padEnd(11, 'x'), channelId: A, published: minute(i), durationS })));
  const ids = (length) => {
    const page = db.listVideos({ channelIds: [A], shorts: 'include', favoritesOnly: false, length, limit: 50 }).videos.map((v) => v.id.replace(/x+$/, ''));
    const shelf = db.listShelves({ channelIds: [A], shorts: 'include', favoritesOnly: false, length, perChannel: 50 }).flatMap((s) => s.videos.map((v) => v.id.replace(/x+$/, '')));
    assert.deepEqual(shelf, page, `shelves and feed agree for ${length}`);
    return page.sort();
  };
  assert.deepEqual(ids('any'), ['s0', 's2700', 's2701', 's899', 's900', 'unknown']);
  assert.deepEqual(ids(undefined), ids('any'));
  assert.deepEqual(ids('short'), ['s0', 's899']);
  assert.deepEqual(ids('medium'), ['s2700', 's900']);
  assert.deepEqual(ids('long'), ['s2701']);
});

test('pacificDay rolls over at midnight Pacific in winter and summer time', () => {
  assert.equal(pacificDay(new Date('2026-11-16T07:59:59Z')), '2026-11-15');
  assert.equal(pacificDay(new Date('2026-11-16T08:00:00Z')), '2026-11-16');
  assert.equal(pacificDay(new Date('2026-07-01T06:59:59Z')), '2026-06-30');
  assert.equal(pacificDay(new Date('2026-07-01T07:00:00Z')), '2026-07-01');
});

test('every metered call counts one unit, and daily totals start over on a new Pacific day', async () => {
  let now = new Date('2026-11-16T07:58:00Z');
  const db = openDb(':memory:', { now: () => now });
  const fetchImpl = async () => new Response('{"items":[]}', { status: 200 });
  const meter = dbMeter(db, fetchApi('k', fetchImpl));
  await meter.api('videos', { id: 'a' });
  await meter.api('videos', { id: 'b' });
  now = new Date('2026-11-16T08:01:00Z');
  await meter.api('videos', { id: 'c' });
  assert.equal(meter.unitsSinceStart, 3);
  assert.equal(db.apiUnitsOn('2026-11-15'), 2);
  assert.equal(db.apiUnitsOn(pacificDay(now)), 1);
  assert.equal(db.apiUnitsOn('2026-11-17'), 0);
});

test('an answer without items throws and leaves the kinds unknown', async () => {
  const db = openDb(':memory:', { now: () => new Date(NOW) });
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.upsertVideos([feedVideo({ id: 'regular0001', channelId: A, published: minute(2) }), feedVideo({ id: 'regular0002', channelId: A, published: minute(1) })]);
  await assert.rejects(fillMissingDetails({ db, api: async () => ({}), maxCalls: 20 }), ApiError);
  assert.deepEqual(Object.fromEntries(durations(db)), { regular0001: [null, null], regular0002: [null, null] });
  assert.equal(db.videosMissingDetails({ unavailableSince: NOW, limit: 10 }).length, 2, 'the next refresh asks again');
});

test('a recent video left out of one answer is asked again and ends as a video', async () => {
  // Far from the real clock, so the 7 days count from the database's clock, not from Date.now().
  const NOW = '2025-03-01T00:00:00.000Z';
  const db = openDb(':memory:', { now: () => new Date(NOW) });
  db.subscribeChannel({ id: A, name: 'A' }, []);
  const daysBefore = (n) => new Date(Date.parse(NOW) - n * 24 * 3_600_000).toISOString();
  db.upsertVideos([feedVideo({ id: 'fresh000001', channelId: A, published: daysBefore(6) }), feedVideo({ id: 'old00000001', channelId: A, published: daysBefore(8) })]);
  const catalog = new Map();
  const { api, calls } = fakeApi(catalog);
  await fillMissingDetails({ db, api, maxCalls: 20 });
  assert.deepEqual(Object.fromEntries(durations(db)), { fresh000001: [null, 'unavailable'], old00000001: [null, 'unavailable'] });

  catalog.set('fresh000001', item('fresh000001', { duration: 'PT7M' }));
  catalog.set('old00000001', item('old00000001', { duration: 'PT7M' }));
  calls.length = 0;
  await fillMissingDetails({ db, api, maxCalls: 20 });
  assert.deepEqual(calls.map((c) => c.ids), [['fresh000001']], 'only the video from the last 7 days is asked again');
  assert.deepEqual(Object.fromEntries(durations(db)), { fresh000001: [420, 'video'], old00000001: [null, 'unavailable'] });
});
