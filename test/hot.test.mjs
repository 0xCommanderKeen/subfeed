import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshViewCounts } from '../src/backfill.mjs';
import { openDb } from '../src/db.mjs';
import { hotSince, withVelocity } from '../src/hot.mjs';
import { ApiError } from '../src/youtube-api.mjs';
import { feedVideo, startApp } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const NOW = '2026-11-17T12:00:00.000Z';
const hoursAgo = (h) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const vid = (name) => name.padEnd(11, '_');
const video = (name, channelId, ageHours, views, extra = {}) =>
  feedVideo({ id: vid(name), channelId, title: name, published: hoursAgo(ageHours), views, durationS: 600, ...extra });
const all = { channelIds: [A, B], shorts: 'include', favoritesOnly: false };

// The database's clock reads clock.at, which a test may move.
function dbWith(videos, clock = { at: NOW }) {
  const db = openDb(':memory:', { now: () => new Date(clock.at) });
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.subscribeChannel({ id: B, name: 'B' }, []);
  db.upsertVideos(videos);
  return db;
}

const hotIds = (db, { offset = 0, limit = 50 } = {}) =>
  db.listHot({ ...all, since: hoursAgo(14 * 24), now: NOW, offset, limit }).videos.map((v) => v.title);

test('Hot ranks the last 14 days by views per hour since publish', () => {
  const db = dbWith([
    video('steady', A, 100, 10_000), // 100 an hour
    video('rocket', B, 2, 1_000), // 500 an hour
    video('big-old', A, 15 * 24, 10_000_000), // outside the window
    video('fresh', A, 0.1, 300), // counts as an hour old: 300 an hour
    video('no-count', B, 1, null),
    video('premiere', B, -5, 900, { kind: 'upcoming' }),
  ]);
  assert.deepEqual(hotIds(db), ['rocket', 'fresh', 'steady']);
  assert.deepEqual(hotIds(db, { limit: 2 }), ['rocket', 'fresh']);
  assert.deepEqual(hotIds(db, { offset: 2, limit: 2 }), ['steady']);
  assert.equal(db.listHot({ ...all, since: hoursAgo(14 * 24), now: NOW, offset: 0, limit: 2 }).more, true);
});

test('the stats refresh counts views of the last 14 days, 50 per call, until they are 6 hours old', async () => {
  const recent = Array.from({ length: 60 }, (_, n) => video(`r${n}`, A, n + 1, 1));
  const clock = { at: NOW };
  const db = dbWith([...recent, video('old', A, 15 * 24, 1), video('gone', A, 3, 1, { kind: 'unavailable' })], clock);
  const calls = [];
  const api = async (endpoint, params) => {
    calls.push({ endpoint, part: params.part, ids: params.id.split(',') });
    return { items: params.id.split(',').map((id) => ({ id, statistics: { viewCount: '777' } })) };
  };

  assert.equal(await refreshViewCounts({ db, api, maxCalls: 10 }), 60);
  assert.deepEqual(calls.map((c) => [c.endpoint, c.part, c.ids.length]), [['videos', 'statistics', 50], ['videos', 'statistics', 10]]);
  assert.ok(!calls.flatMap((c) => c.ids).includes(vid('old')), 'a video older than 14 days is not counted');
  assert.ok(!calls.flatMap((c) => c.ids).includes(vid('gone')), 'an unavailable video is not counted');
  assert.equal(db.getVideo(vid('r0')).views, 777);

  calls.length = 0;
  clock.at = hoursAgo(-5);
  assert.equal(await refreshViewCounts({ db, api, maxCalls: 10 }), 0);
  assert.equal(calls.length, 0, 'counts under 6 hours old are not looked up');
  clock.at = hoursAgo(-7);
  assert.equal(await refreshViewCounts({ db, api, maxCalls: 1 }), 50);
});

test('a details lookup counts as a fresh view count, so the stats refresh skips it', async () => {
  const db = dbWith([video('new', A, 1, null)]);
  db.applyDetails([{ id: vid('new'), durationS: 60, views: 5, kind: 'video' }]);
  const api = async () => assert.fail('no call expected');
  assert.equal(await refreshViewCounts({ db, api, maxCalls: 10 }), 0);
});

test('a flame marks a video far above the channel usual views per hour', () => {
  const rate = (r) => video('x', A, 10, r * 10);
  const usualOf = (rates) => ({ n: rates.length, total: rates.reduce((a, b) => a + b, 0) });
  assert.equal(withVelocity(rate(300), usualOf([300, 100, 100, 100]), NOW).flame, true);
  assert.equal(withVelocity(rate(299), usualOf([299, 100, 100, 100]), NOW).flame, false);
  assert.equal(withVelocity(rate(300), usualOf([300, 100, 100]), NOW).flame, false, 'two other videos are too few to compare with');
  assert.equal(withVelocity(rate(300), usualOf([300, 100, 100, 100]), NOW).viewsPerHour, 300);
  assert.deepEqual(withVelocity(video('old', A, 15 * 24, 5), undefined, NOW), { ...video('old', A, 15 * 24, 5), viewsPerHour: null, flame: false });
});

// As a stats refresh at `at` that brought no new counts for `videos`.
function countedAt(s, videos, at) {
  s.clock.at = at;
  s.db.applyStats(videos.map((v) => ({ id: v.id, views: null })));
  s.clock.at = NOW;
}

// `counted` is when the stats refresh last looked up every video's count; null for never.
async function start(t, { api = null, videos = [], counted = NOW } = {}) {
  const clock = { at: NOW };
  const s = { ...(await startApp(t, { db: dbWith(videos, clock), api })), clock };
  if (counted) countedAt(s, videos, counted);
  return s;
}

test('without an API key there is no Hot', async (t) => {
  const s = await start(t, { videos: [video('a', A, 2, 100)] });
  assert.equal((await s.json('GET', '/api/meta')).body.hot, false);
  assert.deepEqual(await s.json('GET', '/api/videos?sort=hot'), { status: 503, body: { error: 'sort=hot needs YOUTUBE_API_KEY; see the README' } });
  const [newest] = (await s.json('GET', '/api/videos')).body.videos;
  assert.equal(newest.flame, undefined, 'stale counts get no flame');
});

test('with an API key, Hot pages through the ranking and flames the outlier', async (t) => {
  const usual = [1, 2, 3, 4].map((n) => video(`usual${n}`, A, 10 * n, 1000 * n)); // 100 an hour each
  const s = await start(t, { api: async () => ({ items: [] }), videos: [...usual, video('outlier', A, 50, 50_000), video('other', B, 5, 1000)] });
  assert.equal((await s.json('GET', '/api/meta')).body.hot, true);
  assert.equal((await s.json('GET', '/api/videos?sort=sideways')).status, 400);
  assert.equal((await s.json('GET', '/api/videos?sort=hot&q=x')).status, 400);

  const first = (await s.json('GET', '/api/videos?sort=hot&limit=2')).body;
  assert.deepEqual(first.videos.map((v) => v.title), ['outlier', 'other']);
  assert.deepEqual(first.videos.map((v) => [v.viewsPerHour, v.flame]), [[1000, true], [200, false]]);
  const second = (await s.json('GET', `/api/videos?sort=hot&limit=2&before=${first.nextCursor}`)).body;
  const third = (await s.json('GET', `/api/videos?sort=hot&limit=2&before=${second.nextCursor}`)).body;
  assert.deepEqual([...second.videos, ...third.videos].map((v) => v.title).sort(), ['usual1', 'usual2', 'usual3', 'usual4']);
  assert.equal(third.nextCursor, null);
  assert.ok(second.videos.every((v) => v.flame === false));

  const newest = (await s.json('GET', '/api/videos')).body.videos;
  assert.equal(newest.find((v) => v.title === 'outlier').flame, true, 'the flame shows in Newest too');
  assert.equal((await s.json('GET', '/api/videos?sort=hot&before=bm9wZQ')).status, 400);
});

test('with an API key but stale view counts, Hot and the flames are hidden', async (t) => {
  const usual = [1, 2, 3, 4].map((n) => video(`usual${n}`, A, 10 * n, 1000 * n));
  const videos = [...usual, video('outlier', A, 50, 50_000)];
  const api = async () => ({ items: [] });
  const hidden = async (s) => {
    assert.equal((await s.json('GET', '/api/meta')).body.hot, false);
    assert.deepEqual(await s.json('GET', '/api/videos?sort=hot'), {
      status: 503, body: { error: 'sort=hot needs fresh view counts; the last lookups failed or have not run yet' },
    });
    assert.equal((await s.json('GET', '/api/videos')).body.videos.find((v) => v.title === 'outlier').flame, undefined);
  };

  const never = await start(t, { api, videos, counted: null });
  await hidden(never);

  const failing = await start(t, { api, videos, counted: hoursAgo(13) });
  await hidden(failing);
  countedAt(failing, [{ id: vid('outlier') }], hoursAgo(1));
  await hidden(failing);
  countedAt(failing, usual, hoursAgo(11));
  assert.equal((await failing.json('GET', '/api/meta')).body.hot, true, 'every count in the window is under 12 hours old');
  assert.equal((await failing.json('GET', '/api/videos?sort=hot')).status, 200);
});

test('a video published since the last refresh does not hide Hot before its first count', async (t) => {
  const s = await start(t, { api: async () => ({ items: [] }), videos: [video('counted', A, 20, 100)] });
  s.db.upsertVideos([video('new', A, 0.5, 10)]);
  assert.equal((await s.json('GET', '/api/meta')).body.hot, true);
});

test('the flame shows in the lists from /api/videos, not on Shelves or Watch Later', async (t) => {
  const usual = [1, 2, 3, 4].map((n) => video(`usual${n}`, A, 10 * n, 1000 * n));
  const s = await start(t, { api: async () => ({ items: [] }), videos: [...usual, video('outlier', A, 50, 50_000)] });
  s.db.enqueue(vid('outlier'));
  const outlier = (videos) => videos.find((v) => v.title === 'outlier');

  assert.equal(outlier((await s.json('GET', `/api/videos?channel=${A}`)).body.videos).flame, true, 'channel page');
  assert.equal(outlier((await s.json('GET', '/api/videos?q=outlier')).body.videos).flame, true, 'search');
  const [shelf] = (await s.json('GET', '/api/shelves')).body.shelves;
  assert.equal(outlier(shelf.videos).flame, undefined, 'shelves');
  assert.equal(outlier((await s.json('GET', '/api/queue')).body.videos).flame, undefined, 'watch later');
});

test('a stats answer without items throws and keeps the counts stale', async () => {
  const db = dbWith([video('r0', A, 1, 1)]);
  await assert.rejects(refreshViewCounts({ db, api: async () => ({}), maxCalls: 10 }), ApiError);
  assert.equal(db.getVideo(vid('r0')).views, 1);
  assert.deepEqual(db.videosNeedingStats({ since: hotSince(NOW), staleBefore: NOW, limit: 10 }), [vid('r0')]);
});

test('an app over a database with a fixed clock clamps visits to that clock and counts and stamps views at it', async (t) => {
  // Far from the real clock, so a lookup at Date.now() would find the video outside its 14 days.
  const at = '2025-03-01T12:00:00.000Z';
  const db = openDb(':memory:', { now: () => new Date(at) });
  db.subscribeChannel({ id: A, name: 'A' }, []);
  const published = new Date(Date.parse(at) - 2 * 3_600_000).toISOString();
  db.upsertVideos([feedVideo({ id: vid('x'), channelId: A, published, views: 1, durationS: 600 })]);
  const api = async (endpoint, params) => ({ items: endpoint === 'videos' ? params.id.split(',').map((id) => ({ id, statistics: { viewCount: '777' } })) : [] });
  const s = await startApp(t, { db, api });

  assert.deepEqual((await s.json('PUT', '/api/visits/all', { seenAt: '2025-06-01T00:00:00.000Z' })).body, { group: 'all', seenAt: at });
  await s.json('POST', '/api/refresh');
  assert.equal((await s.json('GET', '/api/videos')).body.videos[0].views, 777);
  const justAfter = new Date(Date.parse(at) + 1).toISOString();
  assert.deepEqual([at, justAfter].map((staleBefore) => db.videosNeedingStats({ since: published, staleBefore, limit: 10 }).length), [0, 1], 'the count is stamped at the clock');
});
