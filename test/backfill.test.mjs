import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKFILL_STALE_MS, BackfillHeld, backfillChannel, parseDuration } from '../src/backfill.mjs';
import { ApiError, fetchApi } from '../src/youtube-api.mjs';
import { openDb } from '../src/db.mjs';
import { testApp } from './helpers.mjs';

const ROOT = join(import.meta.dirname, '..');
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'youtube-api.json'), 'utf8'));

// Serves the fixture by endpoint, playlist (or video ids) and page token; records each requested URL.
function fakeYoutube() {
  const requests = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    requests.push(u);
    const endpoint = u.pathname.split('/').pop();
    const key = `${endpoint} ${u.searchParams.get('playlistId') ?? u.searchParams.get('id')} ${u.searchParams.get('pageToken') ?? ''}`;
    const entry = fixture[key];
    if (!entry) throw new Error(`fixture has no response for ${key}`);
    return new Response(JSON.stringify(entry.body), { status: entry.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { requests, api: fetchApi('test-key', fetchImpl) };
}

function channelDb(now) {
  const db = openDb(':memory:', { now });
  for (const c of ['a', 'b', 'c']) db.subscribeChannel({ id: `UC${c.repeat(22)}`, name: `Channel ${c}` }, []);
  return db;
}

const all = (db) =>
  db.listVideos({ channelIds: ['UCaaaaaaaaaaaaaaaaaaaaaa', 'UCbbbbbbbbbbbbbbbbbbbbbb'], shorts: 'include', favoritesOnly: false, limit: 200 }).videos;

test('parseDuration converts ISO-8601 durations to seconds', () => {
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT14M'), 840);
  assert.equal(parseDuration('PT45S'), 45);
  assert.equal(parseDuration('P1DT2S'), 86402);
  assert.equal(parseDuration('P0D'), 0);
  assert.equal(parseDuration('garbage'), null);
  assert.equal(parseDuration(undefined), null);
});

test('backfill pages through the uploads playlists, joins video details and treats a missing Shorts or streams playlist as empty', async () => {
  const db = channelDb();
  const { api, requests } = fakeYoutube();
  const counts = await backfillChannel({ id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'Channel A' }, { api, db });

  assert.deepEqual(counts, { long: 3, short: 0 });
  assert.equal(requests.length, 6, '2 playlist pages + 2 videos.list + the Shorts and streams 404s');
  const first = requests[0].searchParams;
  assert.equal(first.get('part'), 'contentDetails,snippet');
  assert.equal(first.get('maxResults'), '50');
  assert.equal(first.get('key'), 'test-key');
  assert.equal(requests[1].searchParams.get('part'), 'contentDetails,statistics,liveStreamingDetails,snippet');

  assert.deepEqual(all(db), [
    {
      id: 'longVideo01', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', title: 'Long video one & friends',
      published: '2025-03-02T15:00:00.000Z', thumbnail: 'https://i.ytimg.com/vi/longVideo01/hqdefault.jpg',
      isShort: false, views: 123456, durationS: 3723, kind: 'video', favorite: false, watched: false, queued: false, position: null,
    },
    {
      id: 'longVideo02', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', title: 'Long video two',
      published: '2025-01-15T09:30:00.000Z', thumbnail: 'https://i.ytimg.com/vi/longVideo02/mqdefault.jpg',
      isShort: false, views: null, durationS: 840, kind: 'video', favorite: false, watched: false, queued: false, position: null,
    },
    {
      id: 'longVideo03', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', title: 'Long video three',
      published: '2024-12-24T18:00:00.000Z', thumbnail: 'https://i.ytimg.com/vi/longVideo03/hqdefault.jpg',
      isShort: false, views: 7, durationS: 86402, kind: 'video', favorite: false, watched: false, queued: false, position: null,
    },
  ]);
  const searched = db.searchPage({ channelIds: ['UCaaaaaaaaaaaaaaaaaaaaaa'], shorts: 'include', favoritesOnly: false, limit: 200, q: 'first upload' });
  assert.deepEqual(searched.videos.map((v) => v.id), ['longVideo01'], 'the playlist item description is stored and searched');
});

test('Shorts playlist items are stored as shorts', async () => {
  const db = channelDb();
  const { api } = fakeYoutube();
  assert.deepEqual(await backfillChannel({ id: 'UCbbbbbbbbbbbbbbbbbbbbbb', name: 'Channel B' }, { api, db }), { long: 0, short: 1 });
  const [v] = all(db);
  assert.equal(v.id, 'shortVid001');
  assert.equal(v.isShort, true);
  assert.equal(v.durationS, 45);
  assert.equal(v.kind, 'short');
});

test('re-running backfill and a later RSS upsert neither duplicate rows nor clear duration', async () => {
  const db = channelDb();
  const { api } = fakeYoutube();
  const channel = { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'Channel A' };
  await backfillChannel(channel, { api, db });
  await backfillChannel(channel, { api, db });
  assert.equal(all(db).length, 3);

  const before = all(db)[0];
  db.upsertVideos([{ ...before, title: 'Renamed', views: 200000, durationS: null }]);
  const after = all(db);
  assert.equal(after.length, 3);
  assert.equal(after[0].title, 'Renamed');
  assert.equal(after[0].views, 200000);
  assert.equal(after[0].durationS, 3723);
});

test('API errors other than 404 propagate with their reason', async () => {
  const db = channelDb();
  const { api } = fakeYoutube();
  await assert.rejects(
    backfillChannel({ id: 'UCcccccccccccccccccccccc', name: 'Channel C' }, { api, db }),
    (err) => err instanceof ApiError && err.status === 403 && err.reason === 'quotaExceeded',
  );
});

test('an error page that is not JSON still rejects with ApiError', async () => {
  const fetchImpl = async () => new Response('<html><body>Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(fetchApi('test-key', fetchImpl)('channels', {}), (err) => err instanceof ApiError && err.status === 502);
});

test('missing YOUTUBE_API_KEY exits 1 with setup instructions', () => {
  // Set but empty, so a developer's .env (which never overrides the environment) cannot supply a key.
  const env = { ...process.env, YOUTUBE_API_KEY: '' };
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'backfill.mjs')], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /YOUTUBE_API_KEY is not set/);
  assert.match(r.stderr, /YouTube Data API v3/);
  assert.match(r.stderr, /Credentials/);
});

const vid = (playlistId, i) => `${playlistId.at(-1)}${String(i).padStart(10, '0')}`;

// A channel of `count` long videos, 50 per page, with no Shorts playlist. Call number `failAt` fails as the network
// does, and from call number `hangAt` on no call answers.
function bigChannel(count, { failAt = null, hangAt = null } = {}) {
  const log = { calls: [] };
  log.api = async (endpoint, params) => {
    log.calls.push({ endpoint, ...params });
    if (log.calls.length === failAt) throw new TypeError('fetch failed');
    if (hangAt !== null && log.calls.length >= hangAt) return new Promise(() => {});
    if (endpoint === 'videos') {
      return { items: params.id.split(',').map((id) => ({ id, contentDetails: { duration: 'PT10M' }, snippet: { liveBroadcastContent: 'none' }, statistics: { viewCount: '5' } })) };
    }
    if (!params.playlistId.startsWith('UULF')) throw new ApiError(404, 'playlistNotFound', 'no Shorts or streams');
    const start = Number(params.pageToken ?? 0);
    const items = [];
    for (let i = start; i < Math.min(start + 50, count); i++) {
      items.push({ snippet: { title: `Video ${i}`, thumbnails: {} }, contentDetails: { videoId: vid(params.playlistId, i), videoPublishedAt: '2025-01-01T00:00:00Z' } });
    }
    return { items, ...(start + 50 < count && { nextPageToken: String(start + 50) }) };
  };
  log.count = (endpoint) => log.calls.filter((c) => c.endpoint === endpoint).length;
  return log;
}

const A = { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'Channel A' };
const B = { id: 'UCbbbbbbbbbbbbbbbbbbbbbb', name: 'Channel B' };
const storedWithDuration = (db, channelId) =>
  db.listVideos({ channelIds: [channelId], shorts: 'include', favoritesOnly: false, limit: 5000 }).videos.filter((v) => v.durationS === 600).length;

test('a backfill of 2,000 videos that fails at call N costs N plus one page and the Shorts and streams lookups when run again', async () => {
  const full = bigChannel(2000);
  await backfillChannel(A, { api: full.api, db: channelDb() });
  assert.equal(full.calls.length, 82, '40 playlist pages, 40 videos.list calls and the missing Shorts and streams playlists');

  for (const [failAt, rerun] of [[79, 4], [78, 6]]) {
    const db = channelDb();
    const failing = bigChannel(2000, { failAt });
    await assert.rejects(backfillChannel(A, { api: failing.api, db }), /fetch failed/);
    assert.equal(failing.calls.length, failAt);
    assert.equal(db.backfill(A.id).state, 'error');
    const again = bigChannel(2000);
    assert.deepEqual(await backfillChannel(A, { api: again.api, db }), { long: 2000, short: 0 });
    assert.equal(again.calls.length, rerun, `a failure at call ${failAt} reads its page again and goes on`);
    assert.equal(again.calls[0].pageToken, failAt === 79 ? '1950' : '1900');
    assert.equal(storedWithDuration(db, A.id), 2000);
    assert.deepEqual({ ...db.backfill(A.id), owner: null, startedAt: null, finishedAt: null, heartbeatAt: null }, {
      state: 'done', owner: null, heartbeatAt: null, playlist: null, pageToken: null, units: failAt + rerun, long: 2000, short: 0, error: null, startedAt: null, finishedAt: null,
    });
  }
});

test('a second backfill of a stored channel asks videos.list for nothing and costs only the playlist pages', async () => {
  const db = channelDb();
  await backfillChannel(A, { api: bigChannel(2000).api, db });
  const second = bigChannel(2000);
  assert.deepEqual(await backfillChannel(A, { api: second.api, db }), { long: 2000, short: 0 });
  assert.equal(second.count('videos'), 0);
  assert.equal(second.calls.length, 42);
  assert.equal(storedWithDuration(db, A.id), 2000);
});

test('a channel that a live run holds is not backfilled by another, and a run whose heartbeat stopped is taken over', async () => {
  let clock = new Date('2026-11-17T12:00:00Z');
  const db = channelDb(() => clock);
  const first = bigChannel(150, { failAt: 3 });
  // Stands for a backfill.mjs that died after storing the first page.
  await assert.rejects(backfillChannel(A, { api: first.api, db, owner: 'dead run' }), /fetch failed/);
  db.claimBackfill(A.id, 'dead run', { now: clock.toISOString(), staleBefore: clock.toISOString() });

  const blocked = bigChannel(150);
  await assert.rejects(backfillChannel(A, { api: blocked.api, db }), BackfillHeld);
  assert.equal(blocked.calls.length, 0);
  assert.equal(db.queueBackfill(A.id, { now: clock.toISOString(), staleBefore: new Date(clock - BACKFILL_STALE_MS).toISOString() }), false, 'the server does not queue it');

  clock = new Date(clock.getTime() + BACKFILL_STALE_MS + 1000);
  const takeover = bigChannel(150);
  assert.deepEqual(await backfillChannel(A, { api: takeover.api, db }), { long: 150, short: 0 });
  assert.equal(takeover.calls[0].pageToken, '50');
});

test('a second createApp on the same database resumes the running backfill at its page and runs the queued one', async () => {
  const db = channelDb();
  const app = (api) => testApp({ db, api });
  // Stops answering at call 5, the third playlist page of A, as a server that is restarted for a deploy.
  const before = app(bigChannel(150, { hangAt: 5 }).api);
  const post = (id) => before.routes.find((r) => r.path === '/api/channels/:id/backfill').handler({ id });
  post(A.id);
  post(B.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual([db.backfill(A.id).state, db.backfill(A.id).pageToken, db.backfill(B.id).state], ['running', '100', 'queued']);

  const after = bigChannel(150);
  app(after.api);
  for (let i = 0; i < 100 && db.backfill(B.id).state !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual([A, B].map((c) => [db.backfill(c.id).state, db.backfill(c.id).long]), [['done', 150], ['done', 150]]);
  assert.deepEqual(after.calls.slice(0, 4).map((c) => [c.endpoint, c.playlistId ?? null, c.pageToken ?? null]), [
    ['playlistItems', 'UULFaaaaaaaaaaaaaaaaaaaaaa', '100'],
    ['videos', null, null],
    ['playlistItems', 'UUSHaaaaaaaaaaaaaaaaaaaaaa', null],
    ['playlistItems', 'UULVaaaaaaaaaaaaaaaaaaaaaa', null],
  ]);
  assert.equal(after.calls.length, 4 + 8, 'A costs its last page and the Shorts and streams lookups; B costs all of it');
});

test('a channel whose backfill.mjs run died shows as failed, and Backfill continues it from its page', async () => {
  let clock = new Date('2026-11-17T12:00:00Z');
  const db = channelDb(() => clock);
  await assert.rejects(backfillChannel(A, { api: bigChannel(150, { failAt: 3 }).api, db, owner: 'killed run' }), /fetch failed/);
  db.claimBackfill(A.id, 'killed run', { now: clock.toISOString(), staleBefore: clock.toISOString() });
  const api = bigChannel(150);
  const app = testApp({ db, api: api.api });
  const route = (method, path) => app.routes.find((r) => r.method === method && r.path === path).handler;
  const channelA = () => route('GET', '/api/channels')({}).channels.find((c) => c.id === A.id);
  assert.equal(channelA().backfill, 'running');

  clock = new Date(clock.getTime() + BACKFILL_STALE_MS + 1000);
  assert.deepEqual([channelA().backfill, channelA().backfillDetail.error], ['error', 'the backfill stopped without finishing']);
  route('POST', '/api/channels/:id/backfill')({ id: A.id });
  for (let i = 0; i < 100 && db.backfill(A.id).state !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual([channelA().backfill, channelA().backfillDetail.long], ['done', 150]);
  assert.equal(api.calls[0].pageToken, '50');
});
