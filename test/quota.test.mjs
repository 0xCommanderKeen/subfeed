import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, BACKFILL_LIMIT, pacificDay, quotaPausingApi, quotaResetAfter } from '../src/youtube-api.mjs';
import { feedVideo, startApp } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';

test('the quota resets one minute after the next midnight Pacific, in winter and summer time', () => {
  assert.equal(quotaResetAfter(new Date('2026-11-17T12:00:00Z')).toISOString(), '2026-11-18T08:01:00.000Z');
  assert.equal(quotaResetAfter(new Date('2026-11-17T07:59:00Z')).toISOString(), '2026-11-17T08:01:00.000Z');
  assert.equal(quotaResetAfter(new Date('2026-07-01T06:30:00Z')).toISOString(), '2026-07-01T07:01:00.000Z');
  assert.equal(quotaResetAfter(new Date('2026-07-01T07:00:00Z')).toISOString(), '2026-07-02T07:01:00.000Z');
  // The night clocks go back: 2026-11-01 is 25 hours long in Pacific time.
  assert.equal(quotaResetAfter(new Date('2026-11-01T07:30:00Z')).toISOString(), '2026-11-02T08:01:00.000Z');
});

function clockAndQuota(units) {
  const day = { units, now: new Date('2026-11-17T12:00:00Z') };
  const waits = [];
  const wait = async (ms) => {
    waits.push(ms);
    day.now = new Date(day.now.getTime() + ms);
    day.units = 0;
  };
  return { day, waits, wait, now: () => day.now, unitsToday: () => day.units };
}

test('a backfill call waits for the quota reset once today’s usage reaches the limit, then makes the call', async () => {
  const q = clockAndQuota(BACKFILL_LIMIT);
  const calls = [];
  const paused = [];
  const api = quotaPausingApi(async (endpoint) => (calls.push([endpoint, q.day.units]), { ok: true }), { ...q, onPause: (at) => paused.push(at.toISOString()) });
  assert.deepEqual(await api('playlistItems', {}), { ok: true });
  assert.deepEqual(paused, ['2026-11-18T08:01:00.000Z']);
  assert.deepEqual(q.waits, [20 * 3600_000 + 60_000]);
  assert.deepEqual(calls, [['playlistItems', 0]], 'the call runs after the reset, not before');
});

test('below the limit calls go straight through', async () => {
  const q = clockAndQuota(BACKFILL_LIMIT - 1);
  const api = quotaPausingApi(async () => 'body', q);
  assert.equal(await api('videos', {}), 'body');
  assert.deepEqual(q.waits, []);
});

test('a quotaExceeded answer pauses and retries the same call; other errors still fail', async () => {
  const q = clockAndQuota(10);
  let tries = 0;
  const api = quotaPausingApi(async (endpoint, params) => {
    if (tries++ === 0) throw new ApiError(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.');
    return params.pageToken;
  }, q);
  assert.equal(await api('playlistItems', { pageToken: 'page7' }), 'page7');
  assert.equal(tries, 2);
  assert.equal(q.waits.length, 1);

  const failing = quotaPausingApi(async () => {
    throw new ApiError(403, 'forbidden', 'nope');
  }, q);
  await assert.rejects(failing('videos', {}), (err) => err.reason === 'forbidden');
  assert.equal(q.waits.length, 1);
});

async function startServer(t, opts) {
  const now = new Date('2026-11-17T12:00:00Z');
  const s = await startApp(t, { now: () => now, ...opts });
  s.db.subscribeChannel({ id: A, name: 'Channel A', handle: '@cha' }, []);
  s.db.addApiUnits(pacificDay(now), BACKFILL_LIMIT);
  return s;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const channelA = async (s) => (await s.json('GET', '/api/channels')).body.channels.find((c) => c.id === A);

test('the Manage list shows a backfill paused for quota with its resume time, and it finishes after the wait', async (t) => {
  const calls = [];
  const api = async (endpoint) => (calls.push(endpoint), { items: [] });
  let resume;
  const waited = [];
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    waited.push(ms);
    resume = resolve;
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const s = await startServer(t, { api, wait });

  await s.json('POST', `/api/channels/${A}/backfill`);
  await settle();
  const paused = await channelA(s);
  assert.equal(paused.backfill, 'running');
  assert.equal(paused.backfillDetail.pausedUntil, '2026-11-18T08:01:00.000Z');
  assert.deepEqual(calls, [], 'no API call past the limit');
  assert.equal(s.db.apiUnitsOn('2026-11-17'), BACKFILL_LIMIT);

  // Midnight: a new Pacific day starts with no units used.
  s.db.addApiUnits('2026-11-17', -BACKFILL_LIMIT);
  resume();
  await settle();
  const done = await channelA(s);
  assert.equal(done.backfill, 'done');
  assert.equal(done.backfillDetail.pausedUntil, undefined);
  assert.deepEqual(calls, ['playlistItems', 'playlistItems', 'playlistItems']);
  assert.equal(waited.length, 1);
});

test('unsubscribing cancels a backfill paused for quota', async (t) => {
  const calls = [];
  const api = async (endpoint) => (calls.push(endpoint), { items: [] });
  let aborted = false;
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(signal.reason);
    });
  });
  const s = await startServer(t, { api, wait });
  await s.json('POST', `/api/channels/${A}/backfill`);
  await settle();
  await s.json('PATCH', `/api/channels/${A}`, { subscribed: false });
  await settle();
  assert.equal(aborted, true);
  assert.equal((await channelA(s)).backfill, 'idle');
  assert.deepEqual(calls, []);
});

test('a new upload of a channel whose backfill is paused for quota is announced', async (t) => {
  const video = (n) => feedVideo({ id: `aaaaaaaaav${n}`, channelId: A, title: `Video ${n}`, published: `2026-11-17T0${n}:00:00.000Z` });
  let feed = [video(1)];
  const sent = [];
  const api = async (endpoint, params) => ({
    items: endpoint === 'videos' ? params.id.split(',').map((id) => ({ id, contentDetails: { duration: 'PT10M' }, snippet: { liveBroadcastContent: 'none' } })) : [],
  });
  const wait = (ms, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const s = await startServer(t, { api, wait, fetchFeeds: async () => ({ videos: feed, error: null }), notify: async (m) => void sent.push(m) });
  s.db.updateChannel(A, { favorite: true });
  s.db.upsertVideos([video(1)]);

  await s.json('POST', `/api/channels/${A}/backfill`);
  await settle();
  assert.ok((await channelA(s)).backfillDetail.pausedUntil);

  feed = [video(1), video(2)];
  await s.app.refresh();
  assert.deepEqual(sent.map((m) => m.body), ['Video 2']);
});
