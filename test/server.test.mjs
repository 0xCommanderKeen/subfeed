import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { SHELL } from '../public/shell.js';
import { createApp } from '../src/server.mjs';
import { feedVideo, startApp } from './helpers.mjs';
import { ApiError } from '../src/youtube-api.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const NOW = new Date('2026-11-17T12:00:00.000Z');

const video = (channelId, n) =>
  feedVideo({ id: `${channelId.slice(-6)}vid${n}`.padStart(11, 'x'), channelId, title: `Video ${n}`, published: new Date(Date.UTC(2026, 10, 15, 12, n)).toISOString() });

const feedsOf = (byChannel) => async (id) => byChannel[id] ?? { videos: [], error: null };

test('createApp without fetchPage throws instead of reaching youtube.com', () => {
  assert.throws(() => createApp({ db: openDb(':memory:'), fetchFeeds: feedsOf({}), hosts: new Set() }), /createApp needs fetchPage/);
});

async function start(t, { channels = [A, B], ...opts } = {}) {
  const s = await startApp(t, { now: () => NOW, ...opts });
  for (const id of channels) s.db.subscribeChannel({ id, name: `Channel ${id.at(-1)}`, handle: `@ch${id.at(-1)}` }, []);
  return s;
}

const channelIn = (list, id) => list.find((c) => c.id === id);

test('an unexpected error answers 500 internal error, logged once with method, path and stack', async (t) => {
  const s = await start(t);
  for (const err of [new Error('SQLITE_CORRUPT: database disk image is malformed'), new ApiError(403, 'forbidden', 'The request is not allowed')]) {
    s.db.listRules = () => {
      throw err;
    };
    const logged = t.mock.method(console, 'error', () => {});
    assert.deepEqual(await s.json('GET', '/api/rules'), { status: 500, body: { error: 'internal error' } });
    assert.equal(logged.mock.callCount(), 1);
    assert.ok(logged.mock.calls[0].arguments[0].startsWith(`GET /api/rules failed: ${err.stack}`));
    logged.mock.restore();
  }
});

test('a malformed absolute-form request target answers 400', async (t) => {
  const s = await start(t);
  const socket = net.connect(s.port, '127.0.0.1');
  socket.end(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`);
  let raw = '';
  for await (const chunk of socket) raw += chunk;
  assert.match(raw, /^HTTP\/1\.1 400 /);
  assert.match(raw, /\r\n\r\n(?:\w+\r\n)?malformed request target/);
  assert.equal((await s.json('GET', '/api/meta')).status, 200);
});

test('routes answer 404 for an unknown path, 405 for a wrong method, and 400 for a bad parameter', async (t) => {
  const s = await start(t);
  assert.deepEqual(await s.json('GET', '/api/nope'), { status: 404, body: { error: 'not found' } });
  assert.deepEqual(await s.json('DELETE', '/api/meta'), { status: 405, body: { error: 'method not allowed' } });
  assert.deepEqual(await s.json('GET', '/api/videos?shorts=sometimes'), { status: 400, body: { error: 'shorts must be include, exclude or only' } });
  assert.deepEqual(await s.json('GET', '/api/shelves?perChannel=0'), { status: 400, body: { error: 'perChannel must be 1 to 50' } });
  assert.deepEqual(await s.json('PUT', '/api/favorites/short'), { status: 400, body: { error: 'videoId must be a video id' } });
});

// The methods and paths of the routes table in docs/api.md: `PATCH` and `DELETE /api/x/:id` names both methods for the path.
function documentedRoutes() {
  const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'api.md'), 'utf8');
  const table = doc.slice(doc.indexOf('## Routes'), doc.indexOf('\n## ', doc.indexOf('## Routes') + 1));
  const routes = new Set();
  for (const row of table.split('\n').filter((line) => line.startsWith('| `'))) {
    let methods = [];
    for (const [, token] of row.split(' | ')[0].matchAll(/`([^`]+)`/g)) {
      const [method, path] = token.split(' ');
      methods.push(method);
      if (!path) continue;
      for (const m of methods) routes.add(`${m} ${path.split('?')[0]}`);
      methods = [];
    }
  }
  return routes;
}

test('every route has a row in the routes table of docs/api.md', async (t) => {
  const s = await start(t);
  const documented = documentedRoutes();
  assert.ok(documented.has('PATCH /api/topics/:id'));
  for (const { method, path } of s.app.routes) assert.ok(documented.has(`${method} ${path}`), `docs/api.md has no row for ${method} ${path}`);
});

test('every path id a route declares refuses a malformed value with 400, and a topic or group that does not exist with 404', async (t) => {
  const s = await start(t);
  const withParams = s.app.routes.filter((route) => route.params);
  assert.ok(withParams.length >= 14);
  for (const { method, path, params } of withParams) {
    for (const [name, type] of Object.entries(params)) {
      const res = await s.json(method, path.replace(`:${name}`, 'bad!'), {});
      if (type.noun) assert.deepEqual(res, { status: 404, body: { error: `no ${type.noun} bad!` } }, `${method} ${path}`);
      else {
        assert.equal(res.status, 400, `${method} ${path}`);
        assert.match(res.body.error, new RegExp(`^${name} must `), `${method} ${path}`);
      }
    }
  }
});

test('/api/videos refuses a bad flag, a bad limit and an unknown parameter instead of ignoring it', async (t) => {
  const s = await start(t);
  const videos = [1, 2, 3, 4, 5].map((n) => video(A, n));
  s.db.upsertVideos(videos);
  await s.json('PUT', `/api/favorites/${videos[0].id}`);
  const cases = [
    ['/api/videos?limit=abc', 400, 'limit must be 1 to 200'],
    ['/api/videos?limit=0', 400, 'limit must be 1 to 200'],
    ['/api/videos?favorites=true', 400, 'favorites must be 1 or absent'],
    ['/api/videos?favourites=1', 400, 'unknown parameter favourites'],
    ['/api/shelves?channels=abc', 400, 'channels must be 1 to 100'],
    ['/api/shelves?limit=5', 400, 'unknown parameter limit'],
    ['/api/queue?favorites=1', 400, 'unknown parameter favorites'],
    ['/api/meta?x=1', 400, 'unknown parameter x'],
  ];
  for (const [path, status, error] of cases) assert.deepEqual(await s.json('GET', path), { status, body: { error } }, path);
  assert.deepEqual((await s.json('GET', '/api/videos?favorites=1')).body.videos.map((v) => v.id), [videos[0].id]);
  assert.equal((await s.json('GET', '/api/videos?limit=200')).body.videos.length, 5);
});

test('a 405 names the allowed methods in an Allow header', async (t) => {
  const s = await start(t);
  const meta = await s.request('DELETE', '/api/meta');
  assert.deepEqual([meta.status, meta.headers.get('allow')], [405, 'GET']);
  const rules = await s.request('PATCH', '/api/rules');
  assert.deepEqual([rules.status, rules.headers.get('allow')], [405, 'GET, POST']);
});

test('a malformed percent-escape is answered 400 and the server keeps serving', async (t) => {
  const s = await start(t);
  assert.deepEqual(await s.json('PUT', '/api/visits/%E0%A4%A', { seenAt: NOW.toISOString() }), { status: 400, body: { error: 'malformed percent-escape in path' } });
  const page = await s.request('GET', '/%E0%A4%A');
  assert.equal(page.status, 400);
  assert.equal(await page.text(), 'malformed percent-escape in path');
  assert.equal((await s.json('GET', '/api/meta')).status, 200);
});

test('/api/meta lists topics in their order, an integer-like id included', async (t) => {
  const s = await start(t);
  s.db.ensureTopic('robotics', 'Robotics');
  s.db.ensureTopic('2024', '2024');
  const { topics } = (await s.json('GET', '/api/meta')).body;
  assert.deepEqual(topics, [{ id: 'robotics', name: 'Robotics', hidden: false }, { id: '2024', name: '2024', hidden: false }]);
});

test('an aborted request body changes nothing and the server keeps serving', async (t) => {
  const s = await start(t);
  const before = (await s.json('GET', '/api/channels')).body.topics;
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/topics', headers: { 'Content-Type': 'application/json', 'Content-Length': 100 } });
    req.on('error', resolve);
    req.write('{"name":"Wood');
    setTimeout(() => req.destroy(), 20);
  });
  const after = await s.json('GET', '/api/channels');
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.topics, before);
});

test('videos and shelves page with nextCursor, and a cursor of the wrong kind is refused', async (t) => {
  const s = await start(t);
  s.db.upsertVideos([video(A, 1), video(A, 2), video(B, 3)]);
  const first = (await s.json('GET', '/api/videos?limit=2')).body;
  assert.deepEqual(first.videos.map((v) => v.title), ['Video 3', 'Video 2']);
  const second = (await s.json('GET', `/api/videos?limit=2&before=${first.nextCursor}`)).body;
  assert.deepEqual([second.videos.map((v) => v.title), second.nextCursor], [['Video 1'], null]);

  const shelf = (await s.json('GET', '/api/shelves?channels=1')).body;
  assert.deepEqual(shelf.shelves.map((x) => x.channelId), [B]);
  const next = (await s.json('GET', `/api/shelves?channels=1&after=${shelf.nextCursor}`)).body;
  assert.deepEqual([next.shelves.map((x) => x.channelId), next.nextCursor], [[A], null]);

  const invalid = { status: 400, body: { error: 'invalid cursor' } };
  assert.deepEqual(await s.json('GET', `/api/videos?before=${shelf.nextCursor}`), invalid);
  assert.deepEqual(await s.json('GET', `/api/shelves?after=${first.nextCursor}`), invalid);
  assert.deepEqual(await s.json('GET', '/api/videos?before=nope'), invalid);
});

test('every video change answers 404 for a video subfeed does not have, and 204 for one it has', async (t) => {
  const s = await start(t);
  const known = video(A, 1);
  s.db.upsertVideos([known]);
  const changes = [['PUT', 'favorites'], ['DELETE', 'favorites'], ['PUT', 'queue'], ['DELETE', 'queue'], ['PUT', 'watched'], ['DELETE', 'watched']];
  for (const [method, kind] of changes) {
    assert.deepEqual(await s.json(method, `/api/${kind}/zzzzzzzzzzz`), { status: 404, body: { error: 'no video zzzzzzzzzzz in subfeed' } }, `${method} ${kind}`);
  }
  assert.equal(s.db.getVideo('zzzzzzzzzzz'), null);
  assert.deepEqual(await s.json('PUT', `/api/favorites/${known.id}`), { status: 204, body: null });
  assert.deepEqual(await s.json('PUT', `/api/queue/${known.id}`, { before: null }), { status: 204, body: null });
  assert.deepEqual(await s.json('PUT', `/api/watched/${known.id}`), { status: 204, body: null });
  assert.deepEqual(s.db.getVideo(known.id).favorite, true);
  assert.deepEqual(s.db.listQueue().map((v) => v.id), [known.id]);
  assert.deepEqual(await s.json('DELETE', `/api/favorites/${known.id}`), { status: 204, body: null });
  assert.deepEqual(await s.json('DELETE', `/api/queue/${known.id}`), { status: 204, body: null });
  assert.deepEqual(await s.json('DELETE', `/api/watched/${known.id}`), { status: 204, body: null });
  assert.deepEqual([s.db.getVideo(known.id).favorite, s.db.listQueue()], [false, []]);
  assert.deepEqual(await s.json('PUT', `/api/queue/${known.id}`, { before: 'x' }), { status: 400, body: { error: 'before must be a video id or null' } });
});

test('a saved position comes back on every list of videos, a second save replaces it, and DELETE clears it to null', async (t) => {
  const s = await start(t);
  const [first, other] = [video(A, 1), video(A, 2)];
  s.db.upsertVideos([first, other]);
  s.db.enqueue(first.id);
  const positions = async () => {
    const { body: listed } = await s.json('GET', `/api/videos?channel=${A}`);
    const { body: queue } = await s.json('GET', '/api/queue');
    const { body: shelves } = await s.json('GET', '/api/shelves');
    const byId = (videos) => Object.fromEntries(videos.map((v) => [v.id, v.position]));
    return { listed: byId(listed.videos), queue: byId(queue.videos), shelves: byId(shelves.shelves.flatMap((sh) => sh.videos)) };
  };
  const everywhere = (at) => ({ listed: { [first.id]: at, [other.id]: null }, queue: { [first.id]: at }, shelves: { [first.id]: at, [other.id]: null } });
  assert.deepEqual(await positions(), everywhere(null));
  assert.deepEqual(await s.json('PUT', `/api/position/${first.id}`, { seconds: 754 }), { status: 204, body: null });
  assert.deepEqual(await positions(), everywhere(754));
  assert.deepEqual(await s.json('PUT', `/api/position/${first.id}`, { seconds: 1203 }), { status: 204, body: null });
  assert.deepEqual(await positions(), everywhere(1203));
  assert.deepEqual(await s.json('DELETE', `/api/position/${first.id}`), { status: 204, body: null });
  assert.deepEqual(await positions(), everywhere(null));
});

test('saving a position refuses a malformed video id or seconds with 400, and a video subfeed does not have with 404', async (t) => {
  const s = await start(t);
  const known = video(A, 1);
  s.db.upsertVideos([known]);
  assert.deepEqual(await s.json('PUT', '/api/position/bad!', { seconds: 60 }), { status: 400, body: { error: 'videoId must be a video id' } });
  for (const seconds of [0, -5, 12.5, '60', null, 604801]) {
    assert.deepEqual(await s.json('PUT', `/api/position/${known.id}`, { seconds }), { status: 400, body: { error: 'seconds must be 1 to 604800' } }, String(seconds));
  }
  assert.deepEqual(await s.json('PUT', `/api/position/${known.id}`, {}), { status: 400, body: { error: 'seconds must be 1 to 604800' } });
  assert.equal(s.db.getVideo(known.id).position, null);
  for (const [method, body] of [['PUT', { seconds: 60 }], ['DELETE', undefined]]) {
    assert.deepEqual(await s.json(method, '/api/position/zzzzzzzzzzz', body), { status: 404, body: { error: 'no video zzzzzzzzzzz in subfeed' } }, method);
  }
});

test('the MCP tools read and change the same videos as the HTTP API', async (t) => {
  const s = await start(t);
  s.db.upsertVideos([video(A, 1), video(A, 2), video(B, 3), { ...video(A, 4), title: 'Short 4', isShort: true }]);
  const titles = (text) => text.split('\n').slice(1).map((line) => line.split(' · ')[0]);
  assert.deepEqual(titles(await s.mcp('search', { query: '  video  ' })), ['Video 3', 'Video 2', 'Video 1']);
  assert.deepEqual(titles(await s.mcp('channel_videos', { channel: '@cha', limit: 1 })), ['Video 2']);
  assert.deepEqual(titles(await s.mcp('channel_videos', { channel: '@cha', include_shorts: true })), ['Short 4', 'Video 2', 'Video 1']);

  await assert.rejects(s.mcp('favorite_video', { video: 'zzzzzzzzzzz' }), { message: 'no video zzzzzzzzzzz in subfeed' });
  await assert.rejects(s.mcp('watch_later', { video: 'zzzzzzzzzzz' }), { message: 'no video zzzzzzzzzzz in subfeed' });
  const { id: videoId } = video(B, 3);
  assert.match(await s.mcp('favorite_video', { video: videoId }), /^★ Video 3 · Channel b · /);
  await s.mcp('watch_later', { video: videoId });
  const { body } = await s.json('GET', '/api/videos?favorites=1&queued=1');
  assert.deepEqual(body.videos.map((v) => v.id), [videoId]);
  assert.equal(await s.mcp('favorite_channel', { channel: '@chb' }), '★ Channel b is a favorite channel.');
  assert.equal(channelIn((await s.json('GET', '/api/channels')).body.channels, B).favorite, true);
});

test('search pages with its cursor and never shows an unsubscribed channel, also across all groups', async (t) => {
  const s = await start(t);
  s.db.upsertVideos([1, 2, 3, 4, 5].map((n) => ({ ...video(A, n), description: `lizardmen ${'x '.repeat(n)}` })));
  s.db.upsertVideos([{ ...video(B, 6), title: 'Lizardmen' }]);
  assert.equal((await s.json('PATCH', `/api/channels/${B}`, { subscribed: false })).status, 200);
  const seen = [];
  let cursor = null;
  do {
    const { status, body } = await s.json('GET', `/api/videos?q=lizardmen&limit=2${cursor ? `&before=${cursor}` : ''}`);
    assert.equal(status, 200);
    if (!cursor) assert.equal(body.total, 5);
    assert.ok(body.videos.every((v) => v.rank === undefined), 'the rank stays in the cursor');
    seen.push(...body.videos.map((v) => v.title));
    cursor = body.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ['Video 1', 'Video 2', 'Video 3', 'Video 4', 'Video 5'], 'the shortest description ranks first');
  assert.equal((await s.json('GET', '/api/videos?q=lizardmen&before=bm90IGEgY3Vyc29y')).status, 400);
});

test('watch_later_queue lists Watch Later in queue order, and watch_later says where it left the video', async (t) => {
  const s = await start(t);
  const old = { ...video(A, 1), title: 'Old', published: new Date(NOW - 28 * 864e5).toISOString() };
  const fresh = { ...video(B, 2), title: 'Fresh', published: new Date(NOW - 2 * 36e5).toISOString() };
  s.db.upsertVideos([old, fresh]);
  const lines = (text) => text.split('\n');

  assert.equal(await s.mcp('watch_later_queue'), 'Watch Later is empty.');
  assert.match(await s.mcp('watch_later', { video: old.id }), /^Old · Channel a · .* · in Watch Later \(1st\)$/);
  assert.match(await s.mcp('watch_later', { video: fresh.id }), /^Fresh · Channel b · .* · in Watch Later \(2nd\)$/);
  assert.match(await s.mcp('watch_later', { video: old.id }), / · in Watch Later \(1st\)$/, 'a queued video keeps its place');
  const both = lines(await s.mcp('watch_later_queue'));
  assert.equal(both[0], '2 videos in Watch Later, next first:');
  assert.deepEqual(both.slice(1).map((line) => line.split(' · ')[0]), ['Old', 'Fresh']);

  assert.match(await s.mcp('watch_later', { video: old.id, queued: false }), /^Old · Channel a · .* · not in Watch Later$/);
  const left = lines(await s.mcp('watch_later_queue'));
  assert.equal(left[0], '1 video in Watch Later, next first:');
  assert.deepEqual(left.slice(1).map((line) => line.split(' · ')[0]), ['Fresh']);
  assert.match(await s.mcp('watch_later', { video: fresh.id }), / · in Watch Later \(1st\)$/);

  assert.match(await s.mcp('favorite_video', { video: fresh.id }), /^★ Fresh · .* · starred$/);
  assert.match(await s.mcp('favorite_video', { video: fresh.id, favorite: false }), /^Fresh · .* · not starred$/);
});

test('watch_later gives the place that watch_later_queue lists, leaving out a queued Short unless the video is a Short', async (t) => {
  const s = await start(t);
  const short = { ...video(A, 1), title: 'Short', isShort: true };
  const long = { ...video(B, 2), title: 'Long' };
  s.db.upsertVideos([short, long]);
  const titles = (text) => text.split('\n').slice(1).map((line) => line.split(' · ')[0]);

  assert.match(await s.mcp('watch_later', { video: short.id }), / · in Watch Later \(1st counting Shorts\)$/);
  assert.match(await s.mcp('watch_later', { video: long.id }), /^Long · .* · in Watch Later \(1st\)$/);
  assert.deepEqual(titles(await s.mcp('watch_later_queue')), ['Long']);
  assert.deepEqual(titles(await s.mcp('watch_later_queue', { include_shorts: true })), ['Short', 'Long']);
});

test('patching a channel answers 404 when it is unknown, and refreshes it only when it is resubscribed', async (t) => {
  const fetched = [];
  const s = await start(t, { fetchFeeds: async (id) => (fetched.push(id), { videos: [], error: null }) });
  assert.deepEqual(await s.json('PATCH', '/api/channels/UCzzzzzzzzzzzzzzzzzzzzzz', { favorite: true }), { status: 404, body: { error: 'no channel UCzzzzzzzzzzzzzzzzzzzzzz' } });
  assert.equal((await s.json('PATCH', `/api/channels/${A}`, { subscribed: true })).status, 200);
  assert.deepEqual(fetched, [], 'a channel that stays subscribed is not refreshed');
  assert.equal((await s.json('PATCH', `/api/channels/${A}`, { subscribed: false })).body.subscribed, false);
  const back = await s.json('PATCH', `/api/channels/${A}`, { subscribed: true, favorite: true });
  assert.deepEqual([back.status, back.body.subscribed, back.body.favorite], [200, true, true]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetched, [A]);
});

test('PUT /api/visits/:group stores when the group was opened', async (t) => {
  const s = await start(t);
  s.db.ensureTopic('print', '3D Printing');
  const seenAt = '2026-11-17T10:00:00.000Z';
  assert.deepEqual(await s.json('PUT', '/api/visits/topic:print', { seenAt }), { status: 200, body: { group: 'topic:print', seenAt } });
  assert.deepEqual((await s.json('GET', '/api/meta')).body.visits, { 'topic:print': seenAt });
});

test('DELETE /api/channels/:id removes the channel and its videos', async (t) => {
  const s = await start(t);
  s.db.upsertVideos([video(A, 1), video(B, 2)]);
  assert.deepEqual(await s.json('DELETE', `/api/channels/${A}`), { status: 204, body: null });
  assert.deepEqual((await s.json('GET', '/api/channels')).body.channels.map((c) => c.id), [B]);
  assert.deepEqual((await s.json('GET', '/api/videos')).body.videos.map((v) => v.title), ['Video 2']);
  assert.equal(s.db.getVideo(video(A, 1).id), null);
});

test('a body over 1 MiB is refused with 413 by the API and by /mcp', async (t) => {
  const s = await start(t);
  const huge = 'x'.repeat((1 << 20) + 1);
  assert.deepEqual(await s.json('POST', '/api/topics', { name: huge }), { status: 413, body: { error: 'body too large' } });
  const mcp = await s.json('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping', params: { huge } });
  assert.deepEqual(mcp, { status: 413, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'body too large' } } });
  assert.equal((await s.json('GET', '/api/meta')).status, 200);
});

test('a refresh where one channel fails stores the others and reports the failure per channel', async (t) => {
  const s = await start(t, { fetchFeeds: feedsOf({ [A]: { videos: [video(A, 1)], error: null }, [B]: { videos: [], error: 'HTTP 500' } }) });
  const { status, body } = await s.json('POST', '/api/refresh');
  assert.equal(status, 200);
  assert.equal(body.lastRefresh, NOW.toISOString());
  assert.equal(body.totalVideos, 1);
  assert.deepEqual(
    [channelIn(body.channels, A), channelIn(body.channels, B)].map(({ ok, error, failedRuns, lastFetched, counts }) => ({ ok, error, failedRuns, lastFetched, long: counts.long })),
    [
      { ok: true, error: undefined, failedRuns: 0, lastFetched: NOW.toISOString(), long: 1 },
      { ok: false, error: 'HTTP 500', failedRuns: 1, lastFetched: null, long: 0 },
    ],
  );
});

test('failedRuns counts the refreshes in a row that failed a channel and goes back to 0 when one succeeds', async (t) => {
  const answers = [{ videos: [], error: 'timeout' }, { videos: [], error: 'timeout' }, { videos: [video(A, 1)], error: null }];
  const s = await start(t, { channels: [A], fetchFeeds: async () => answers.shift() });
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(channelIn((await s.json('POST', '/api/refresh')).body.channels, A).failedRuns);
  assert.deepEqual(runs, [1, 2, 0]);
});

test('unsubscribing cancels a running backfill before its next API call', async (t) => {
  const calls = [];
  let release;
  const api = (endpoint, params) => {
    calls.push(endpoint);
    return new Promise((resolve) => {
      release = () => resolve({ items: [{ contentDetails: { videoId: 'aaaaaaaaaaa', videoPublishedAt: NOW.toISOString() }, snippet: { title: 'Old' } }] });
    });
  };
  const s = await start(t, { api });
  const started = await s.json('POST', `/api/channels/${A}/backfill`);
  assert.equal(started.body.backfill, 'running');
  const unsubscribed = await s.json('PATCH', `/api/channels/${A}`, { subscribed: false });
  assert.equal(unsubscribed.body.backfill, 'idle');
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['playlistItems']);
  assert.equal(s.db.getVideo('aaaaaaaaaaa'), null);
  const { channels } = (await s.json('GET', '/api/channels')).body;
  assert.equal(channelIn(channels, A).backfill, 'idle');
  assert.equal(channelIn(channels, A).backfillDetail, null);
});

test('adding a channel looks it up, stores its feed, and backfills it', async (t) => {
  const C = 'UCcccccccccccccccccccccc';
  const calls = [];
  const api = async (endpoint, params) => {
    calls.push([endpoint, params.forHandle ?? params.playlistId ?? params.id]);
    if (endpoint === 'channels') return { items: [{ id: C, snippet: { title: 'Channel C' } }] };
    return { items: [] };
  };
  const s = await start(t, { channels: [], api, fetchFeeds: feedsOf({ [C]: { videos: [video(C, 1)], error: null } }) });
  const { status, body } = await s.json('POST', '/api/channels', { input: '@chc' });
  assert.equal(status, 200);
  assert.equal(body.created, true);
  assert.deepEqual({ id: body.channel.id, name: body.channel.name, handle: body.channel.handle, ok: body.channel.ok, long: body.channel.counts.long }, {
    id: C,
    name: 'Channel C',
    handle: '@chc',
    ok: true,
    long: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const { channels, apiUnits } = (await s.json('GET', '/api/channels')).body;
  assert.equal(channelIn(channels, C).backfill, 'done');
  assert.equal(calls[0][0], 'channels');
  assert.equal(apiUnits, calls.length);
  assert.equal((await s.json('GET', '/api/meta')).body.apiUnits.today, calls.length);
});

test('adding a channel answers 502 when the lookup fails, and 404 when YouTube has no such channel', async (t) => {
  let fail = true;
  const api = async () => {
    if (fail) throw new Error('quota exceeded');
    return { items: [] };
  };
  const s = await start(t, { channels: [], api });
  const failed = await s.json('POST', '/api/channels', { input: '@nobody' });
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /Could not reach YouTube: quota exceeded/);
  fail = false;
  assert.equal((await s.json('POST', '/api/channels', { input: '@nobody' })).status, 404);
  assert.deepEqual((await s.json('GET', '/api/channels')).body.channels, []);
});

test('the Manage list carries each channel’s latest upload per kind, for the Inactive view', async (t) => {
  const s = await start(t);
  s.db.upsertVideos([video(A, 1), video(A, 2)]);
  const { channels } = (await s.json('GET', '/api/channels')).body;
  assert.deepEqual(channelIn(channels, A).latest, { long: video(A, 2).published, short: null, stream: null });
  assert.deepEqual(channelIn(channels, B).latest, { long: null, short: null, stream: null });
});

test('POST /api/topics/:id/channels adds or removes one topic on several channels', async (t) => {
  const s = await start(t);
  const { body: topic } = await s.json('POST', '/api/topics', { name: 'Music' });
  const path = `/api/topics/${topic.id}/channels`;
  assert.deepEqual(await s.json('POST', path, { channels: [A, B], linked: true }), { status: 200, body: { changed: 2 } });
  assert.deepEqual(await s.json('POST', path, { channels: [A, B], linked: true }), { status: 200, body: { changed: 0 } });
  let { body } = await s.json('GET', '/api/channels');
  assert.deepEqual([channelIn(body.channels, A).topics, channelIn(body.channels, B).topics], [[topic.id], [topic.id]]);
  assert.deepEqual(await s.json('POST', path, { channels: [A], linked: false }), { status: 200, body: { changed: 1 } });
  ({ body } = await s.json('GET', '/api/channels'));
  assert.deepEqual([channelIn(body.channels, A).topics, channelIn(body.channels, B).topics], [[], [topic.id]]);
  assert.equal((await s.json('POST', '/api/topics/nope/channels', { channels: [A], linked: true })).status, 404);
  assert.equal((await s.json('POST', path, { channels: [], linked: true })).status, 400);
  assert.equal((await s.json('POST', path, { channels: ['UCzzzzzzzzzzzzzzzzzzzzzz'], linked: true })).status, 400);
  assert.equal((await s.json('POST', path, { channels: [A] })).status, 400);
});

const RICK = 'UCuAXFkgsw1L7xaCfnd5JJOw';
const watchPage = readFileSync(join(import.meta.dirname, 'fixtures', 'watch-page.html'), 'utf8');
const SHARED = 'dQw4w9WgXcQ';
const watchPages = (channelId) => async (url) =>
  url === `https://www.youtube.com/watch?v=${SHARED}` ? new Response(watchPage.replaceAll(RICK, channelId)) : new Response('<html></html>');
const queueIds = async (s) => (await s.json('GET', '/api/queue')).body.videos.map((v) => v.id);

test('Watch Later lists the queue in the order set by moves, or by when each video was added, newest or oldest first', async (t) => {
  let tick = 0;
  const s = await start(t, { now: () => new Date(NOW.getTime() + 1000 * tick++) });
  const [first, second, third] = [video(A, 1), video(A, 2), video(B, 3)];
  s.db.upsertVideos([first, second, third]);
  for (const v of [first, second, third]) assert.equal((await s.json('PUT', `/api/queue/${v.id}`)).status, 204);
  await s.json('PUT', `/api/queue/${first.id}`, { before: null });
  const ids = async (order) => (await s.json('GET', `/api/queue?order=${order}`)).body.videos.map((v) => v.id);
  assert.deepEqual(await queueIds(s), [second.id, third.id, first.id], 'the default is the order set by moves');
  assert.deepEqual(await ids('queue'), [second.id, third.id, first.id]);
  assert.deepEqual(await ids('newest'), [third.id, second.id, first.id]);
  assert.deepEqual(await ids('oldest'), [first.id, second.id, third.id]);
  assert.equal((await s.json('GET', '/api/queue?order=random')).status, 400);
});

test('sharing a stored video puts it at the end of Watch Later without asking YouTube', async (t) => {
  const s = await start(t, { fetchPage: async () => assert.fail('no YouTube lookup for a stored video') });
  const [first, second] = [video(A, 1), video(B, 2)];
  s.db.upsertVideos([first, second]);
  s.db.enqueue(first.id);
  const { status, body } = await s.json('POST', '/api/share', { url: `https://youtu.be/${second.id}?si=abc` });
  assert.equal(status, 200);
  assert.equal(body.queued, true);
  assert.equal(body.video.title, 'Video 2');
  assert.deepEqual(body.channel, { id: B, name: 'Channel b', subscribed: true });
  assert.deepEqual(await queueIds(s), [first.id, second.id]);
});

test('sharing a new video of a known channel stores it from its watch page and queues it', async (t) => {
  const s = await start(t, { fetchPage: watchPages(A) });
  const { body } = await s.json('POST', '/api/share', { url: `https://www.youtube.com/watch?v=${SHARED}` });
  assert.equal(body.queued, true);
  assert.deepEqual(body.channel, { id: A, name: 'Channel a', subscribed: true });
  assert.equal(s.db.getVideo(SHARED).published, '2009-10-25T06:57:33.000Z');
  assert.equal(s.db.getVideo(SHARED).durationS, 213);
  assert.deepEqual(await queueIds(s), [SHARED]);
});

test('sharing a video of a channel not in subfeed stores nothing and names the channel to add', async (t) => {
  const s = await start(t, { fetchPage: watchPages(RICK) });
  const { status, body } = await s.json('POST', '/api/share', { url: `https://youtu.be/${SHARED}` });
  assert.equal(status, 200);
  assert.equal(body.queued, false);
  assert.deepEqual(body.channel, { id: RICK, name: 'Rick Astley', subscribed: false });
  assert.equal(body.video.url, `https://www.youtube.com/watch?v=${SHARED}`);
  assert.equal(s.db.getVideo(SHARED), null);
  assert.deepEqual(await queueIds(s), []);

  s.db.subscribeChannel({ id: RICK, name: 'Rick Astley', handle: '@RickAstleyYT' }, []);
  assert.equal((await s.json('POST', '/api/share', { url: `https://youtu.be/${SHARED}` })).body.queued, true, 'queued once the channel is added');
  assert.deepEqual(await queueIds(s), [SHARED]);
});

test('sharing refuses a link that is not a video and reports a video YouTube does not have', async (t) => {
  const s = await start(t, { fetchPage: watchPages(A) });
  const notVideo = { status: 400, body: { error: 'url must be a YouTube video link' } };
  assert.deepEqual(await s.json('POST', '/api/share', { url: 'https://www.youtube.com/@CNCKitchen' }), notVideo);
  assert.deepEqual(await s.json('POST', '/api/share', { url: 42 }), notVideo);
  assert.deepEqual(await s.json('POST', '/api/share', { url: 'https://youtu.be/aaaaaaaaaaa' }), { status: 404, body: { error: 'No YouTube video aaaaaaaaaaa' } });
});

test('the self-hosted font and its licence are served with their own types', async (t) => {
  const s = await start(t);
  for (const [path, type] of [['/archivo-latin.woff2', 'font/woff2'], ['/archivo-OFL.txt', 'text/plain; charset=utf-8']]) {
    const res = await s.request('GET', path);
    assert.deepEqual([res.status, res.headers.get('content-type')], [200, type], path);
  }
});

test('the manifest makes subfeed installable and a share target for links', async (t) => {
  const s = await start(t);
  const res = await s.request('GET', '/manifest.webmanifest');
  assert.equal(res.headers.get('content-type'), 'application/manifest+json');
  const manifest = await res.json();
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.share_target, { action: '/share.html', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } });
  for (const size of ['192x192', '512x512']) assert.ok(manifest.icons.some((i) => i.sizes === size && i.type === 'image/png'), `a ${size} PNG icon`);
  for (const icon of manifest.icons) assert.equal((await s.request('GET', `/${icon.src}`)).status, 200, icon.src);
  for (const page of ['/', '/manage.html', '/share.html?text=x']) assert.match(await (await s.request('GET', page)).text(), /<link rel="manifest" href="manifest.webmanifest">/, page);
});

test('the service worker keeps every file of the app shell', () => {
  const files = readdirSync(join(import.meta.dirname, '..', 'public')).filter((f) => f !== 'sw.js');
  assert.deepEqual(SHELL.filter((f) => f !== './').toSorted(), files.toSorted());
});

test('a channel added after the first /api/meta is in the next one, as in the videos it already lists', async (t) => {
  const s = await start(t, { channels: [A], fetchFeeds: feedsOf({ [A]: { videos: [video(A, 1)], error: null }, [B]: { videos: [video(B, 2)], error: null } }) });
  await s.json('POST', '/api/refresh');
  assert.equal(channelIn((await s.json('GET', '/api/meta')).body.channels, B), undefined);
  s.db.subscribeChannel({ id: B, name: 'Channel b', handle: '@chb' }, []);
  await s.json('POST', '/api/refresh');
  assert.ok((await s.json('GET', '/api/videos')).body.videos.some((v) => v.channelId === B));
  assert.equal(channelIn((await s.json('GET', '/api/meta')).body.channels, B).name, 'Channel b');
});
