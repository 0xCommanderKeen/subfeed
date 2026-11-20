import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchSubscriptions } from '../src/import-subs.mjs';
import { ApiError } from '../src/youtube-api.mjs';
import { feedVideo, startApp } from './helpers.mjs';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const id = (n) => `UC${String(n).padStart(22, '0')}`;
const OWNER = id(999);
const subscription = (channelId, title = `Channel ${channelId.slice(-3)}`) => ({ snippet: { title, resourceId: { kind: 'youtube#channel', channelId } } });

// A fake Data API: subscriptions.list answers `state.subs` two per page, or throws `state.error`; channels.list knows
// every id.
function fakeApi(state) {
  const calls = [];
  const api = async (endpoint, params) => {
    calls.push({ endpoint, ...params });
    if (endpoint === 'subscriptions') {
      if (state.error) throw state.error;
      const at = Number(params.pageToken ?? 0);
      const next = at + 2 < state.subs.length ? String(at + 2) : undefined;
      return { items: state.subs.slice(at, at + 2).map((c) => subscription(c)), nextPageToken: next };
    }
    if (endpoint === 'channels') {
      return { items: params.id.split(',').map((c) => ({ id: c, snippet: { title: `Channel ${c.slice(-3)}`, description: '' }, statistics: { videoCount: '10' } })) };
    }
    return { items: [] };
  };
  return { api, calls };
}

async function start(t, { subs = [], youtubeChannelId = OWNER, withKey = true, ...opts } = {}) {
  const state = { subs, error: null };
  const yt = fakeApi(state);
  const fetched = [];
  const fetchFeeds = async (cid) => {
    fetched.push(cid);
    return { videos: [feedVideo({ id: `v${cid.slice(-10)}`, channelId: cid, published: NOW.toISOString() })], error: null };
  };
  const s = await startApp(t, { now: () => NOW, fetchFeeds, api: withKey ? yt.api : null, youtubeChannelId, ...opts });
  return { ...s, state, calls: yt.calls, fetched };
}

const youtubeMeta = async (s) => (await s.json('GET', '/api/meta')).body.youtubeSubscriptions;

test('fetchSubscriptions reads every page, lists each channel once, and skips items that are not channels', async () => {
  const pages = {
    '': { items: [subscription(id(1), 'One'), subscription(id(2), 'Two')], nextPageToken: 'p2' },
    p2: { items: [subscription(id(1), 'One again'), subscription('not-an-id'), { snippet: { title: 'Untitled', resourceId: { channelId: id(3) } } }] },
  };
  const calls = [];
  const api = async (endpoint, params) => {
    calls.push([endpoint, params]);
    return pages[params.pageToken ?? ''];
  };
  assert.deepEqual(await fetchSubscriptions(api, OWNER), [
    { id: id(1), title: 'One' },
    { id: id(2), title: 'Two' },
    { id: id(3), title: 'Untitled' },
  ]);
  assert.deepEqual(calls, [
    ['subscriptions', { part: 'snippet', channelId: OWNER, maxResults: '50' }],
    ['subscriptions', { part: 'snippet', channelId: OWNER, maxResults: '50', pageToken: 'p2' }],
  ]);
});

test('fetchSubscriptions says how to make private subscriptions public, and names a channel YouTube does not have', async () => {
  const failing = (err) => async () => Promise.reject(err);
  await assert.rejects(fetchSubscriptions(failing(new ApiError(403, 'subscriptionForbidden', 'forbidden')), OWNER), /subscriptions are private.*Privacy/);
  await assert.rejects(fetchSubscriptions(failing(new ApiError(404, 'subscriberNotFound', 'not found')), OWNER), new RegExp(`no channel ${OWNER}.*YOUTUBE_CHANNEL_ID`));
  await assert.rejects(fetchSubscriptions(failing(new ApiError(403, 'quotaExceeded', 'quota')), OWNER), /HTTP 403 quotaExceeded/);
});

test('a refresh records the YouTube subscriptions, and /api/meta counts only the channels that are not in subfeed', async (t) => {
  const s = await start(t, { subs: [id(1), id(2), id(3), id(4), id(5)] });
  assert.deepEqual(await youtubeMeta(s), { newChannels: 0, checkedAt: null, error: null });
  s.db.subscribeChannel({ id: id(1), name: 'Subscribed' }, []);
  s.db.subscribeChannel({ id: id(2), name: 'Dropped' }, []);
  s.db.updateChannel(id(2), { subscribed: false });

  const refreshed = await s.json('POST', '/api/refresh');
  assert.deepEqual(refreshed.body.youtubeSubscriptions, { newChannels: 3, checkedAt: NOW.toISOString(), error: null });
  assert.equal(s.calls.filter((c) => c.endpoint === 'subscriptions').length, 3, 'one call per page');
  assert.ok(refreshed.body.apiUnits.lastRefresh >= 3, 'the check counts toward the refresh units');

  s.db.subscribeChannel({ id: id(3), name: 'Added by hand' }, []);
  assert.equal((await youtubeMeta(s)).newChannels, 2);
});

test('the YouTube subscriptions are off without YOUTUBE_CHANNEL_ID or without an API key', async (t) => {
  for (const opts of [{ youtubeChannelId: null }, { withKey: false }]) {
    const s = await start(t, { subs: [id(1)], ...opts });
    await s.json('POST', '/api/refresh');
    assert.equal(await youtubeMeta(s), null);
    assert.ok(!s.calls.some((c) => c.endpoint === 'subscriptions'));
    const preview = await s.json('POST', '/api/youtube-subscriptions/preview');
    assert.equal(preview.status, 503);
    assert.match(preview.body.error, /YOUTUBE_CHANNEL_ID/);
  }
});

test('the YouTube preview lists the subscribed channels that are not in subfeed, after the first check', async (t) => {
  const s = await start(t, { subs: [id(1), id(2), id(3)] });
  s.db.subscribeChannel({ id: id(1), name: 'Known' }, []);
  const early = await s.json('POST', '/api/youtube-subscriptions/preview');
  assert.equal(early.status, 409);
  assert.match(early.body.error, /refresh/);

  await s.json('POST', '/api/refresh');
  const { status, body } = await s.json('POST', '/api/youtube-subscriptions/preview');
  assert.equal(status, 200);
  assert.deepEqual(body.channels.map((c) => [c.id, c.name, c.videoCount]), [[id(2), 'Channel 002', 10], [id(3), 'Channel 003', 10]]);
  assert.deepEqual([body.listed, body.alreadyIn, body.notFound], [3, 1, 0]);
});

test('importing a channel with subscribed false stores it unsubscribed with no feed fetch or backfill, and it is not offered again', async (t) => {
  const s = await start(t, { subs: [id(1), id(2)] });
  await s.json('POST', '/api/refresh');
  const { channels } = (await s.json('POST', '/api/youtube-subscriptions/preview')).body;
  const items = channels.map((c) => ({ ...c, topics: [], subscribed: c.id === id(1) }));

  const done = await s.json('POST', '/api/import', { channels: items });
  assert.deepEqual(done.body, { added: 1, ignored: 1, skipped: 0, backfillsQueued: 1 });
  assert.deepEqual(s.fetched, [id(1)]);
  const stored = new Map(s.db.listChannels().map((c) => [c.id, c.subscribed]));
  assert.deepEqual([stored.get(id(1)), stored.get(id(2))], [true, false]);
  assert.equal(s.db.backfill(id(2)), undefined, 'the ignored channel has no backfill');
  assert.equal((await youtubeMeta(s)).newChannels, 0);
  assert.equal((await s.json('POST', '/api/youtube-subscriptions/preview')).body.channels.length, 0);

  const bad = await s.json('POST', '/api/import', { channels: [{ id: id(3), name: 'x', topics: [], subscribed: 'no' }] });
  assert.equal(bad.status, 400);
});

test('a failed check keeps the last list and reports the error, and the refresh still finishes', async (t) => {
  const s = await start(t, { subs: [id(1), id(2)] });
  await s.json('POST', '/api/refresh');
  s.state.error = new ApiError(403, 'subscriptionForbidden', 'forbidden');

  const refreshed = await s.json('POST', '/api/refresh');
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.lastRefresh, NOW.toISOString());
  const { newChannels, error } = refreshed.body.youtubeSubscriptions;
  assert.equal(newChannels, 2);
  assert.match(error, /subscriptions are private/);
  assert.equal((await s.json('POST', '/api/youtube-subscriptions/preview')).body.channels.length, 2);

  s.state.error = null;
  assert.equal((await s.json('POST', '/api/refresh')).body.youtubeSubscriptions.error, null);
});
