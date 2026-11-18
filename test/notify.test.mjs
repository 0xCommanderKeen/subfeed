import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backfillChannel } from '../src/backfill.mjs';
import { fetchApi } from '../src/youtube-api.mjs';
import { openDb } from '../src/db.mjs';
import { notifyNewUploads, ntfySender } from '../src/notify.mjs';
import { refreshFeeds } from '../src/refresh.mjs';
import { feedVideo, testApp } from './helpers.mjs';

const FAV = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'UCbbbbbbbbbbbbbbbbbbbbbb';

const video = (id, channelId, minute, isShort = false) => feedVideo({
  id, channelId, title: `Title of ${id}`, published: new Date(Date.UTC(2026, 10, 15, 12, minute)).toISOString(), thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, isShort,
});

// `feeds` maps channel id -> the videos its RSS feeds currently list; change it between refreshes.
function setup(file = ':memory:') {
  const db = openDb(file);
  db.subscribeChannel({ id: FAV, name: 'Favorite Channel' }, []);
  db.subscribeChannel({ id: OTHER, name: 'Other Channel' }, []);
  db.updateChannel(FAV, { favorite: true });
  const feeds = new Map([[FAV, [video('fav00000001', FAV, 1)]], [OTHER, [video('oth00000001', OTHER, 1)]]]);
  const sent = [];
  const send = async (message) => void sent.push(message);
  const refresh = async (backfillingChannelIds = []) => {
    const announce = (id) => !backfillingChannelIds.includes(id);
    await refreshFeeds(db, [FAV, OTHER], { fetchFeeds: async (id) => ({ videos: feeds.get(id), error: null }), announce });
    return notifyNewUploads({ db, send });
  };
  return { db, feeds, sent, refresh };
}

test('the first refresh of a new database announces nothing', async () => {
  const { sent, refresh } = setup();
  assert.equal(await refresh(), 0);
  assert.deepEqual(sent, []);
});

test('a new upload from a favorite channel is announced exactly once, also after a restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-notify-')), 'subfeed.db');
  const first = setup(file);
  await first.refresh();
  first.feeds.get(FAV).push(video('fav00000002', FAV, 2));
  first.feeds.get(OTHER).push(video('oth00000002', OTHER, 2));
  assert.equal(await first.refresh(), 1);
  assert.deepEqual(first.sent, [{
    title: 'Favorite Channel', body: 'Title of fav00000002', click: 'https://www.youtube.com/watch?v=fav00000002',
    attach: 'https://i.ytimg.com/vi/fav00000002/hqdefault.jpg', tags: 'tv',
  }]);
  assert.equal(await first.refresh(), 0, 'a second refresh sends nothing');
  first.db.close();

  const restarted = openDb(file);
  const sent = [];
  const ids = await refreshFeeds(restarted, [FAV], { fetchFeeds: async () => ({ videos: first.feeds.get(FAV), error: null }), announce: () => true });
  assert.deepEqual(ids, []);
  assert.equal(await notifyNewUploads({ db: restarted, send: async (m) => void sent.push(m) }), 0, 'notified_at survives the restart');
  assert.deepEqual(sent, []);
});

test('Shorts, upcoming premieres and non-favorite channels are not announced', async () => {
  const { db, feeds, sent, refresh } = setup();
  await refresh();
  feeds.get(FAV).push(video('short000001', FAV, 2, true), video('premiere001', FAV, 3), video('fav00000004', FAV, 4));
  feeds.get(OTHER).push(video('oth00000002', OTHER, 2));
  const ids = await refreshFeeds(db, [FAV, OTHER], { fetchFeeds: async (id) => ({ videos: feeds.get(id), error: null }), announce: () => true });
  assert.deepEqual(ids.toSorted(), ['fav00000004', 'oth00000002', 'premiere001', 'short000001']);
  db.applyDetails([{ id: 'premiere001', durationS: null, views: null, kind: 'upcoming' }]);
  await notifyNewUploads({ db, send: async (m) => void sent.push(m) });
  assert.deepEqual(sent.map((m) => m.body), ['Title of fav00000004']);
  assert.equal(await refresh(), 0);
});

test('videos a backfill stored, or that arrive while the channel is backfilled, are not announced', async () => {
  const { db, feeds, sent, refresh } = setup();
  await refresh();
  const api = fetchApi('k', async (url) => {
    const endpoint = new URL(url).pathname.split('/').pop();
    if (endpoint === 'videos') return Response.json({ items: [{ id: 'backfill001', contentDetails: { duration: 'PT20M' }, snippet: { liveBroadcastContent: 'none' } }] });
    const playlist = new URL(url).searchParams.get('playlistId');
    if (playlist.startsWith('UUSH')) return Response.json({ error: { message: 'none', errors: [{ reason: 'playlistNotFound' }] } }, { status: 404 });
    return Response.json({ items: [{ snippet: { title: 'Older upload', thumbnails: {} }, contentDetails: { videoId: 'backfill001', videoPublishedAt: '2026-11-15T12:05:00Z' } }] });
  });
  await backfillChannel({ id: FAV, name: 'Favorite Channel' }, { api, db });
  feeds.get(FAV).push(video('backfill001', FAV, 5));
  assert.equal(await refresh(), 0, 'already stored by the backfill');

  feeds.get(FAV).push(video('fav00000006', FAV, 6));
  assert.equal(await refresh([FAV]), 0, 'the channel is being backfilled');
  assert.deepEqual(sent, []);
});

test('after the upgrade no video stored before it is announced, and an announced one keeps its notified_at', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-notify-')), 'subfeed.db');
  const { db, feeds, refresh } = setup(file);
  await refresh();
  feeds.get(FAV).push(video('fav00000002', FAV, 2), video('fav00000003', FAV, 3));
  await refreshFeeds(db, [FAV], { fetchFeeds: async (id) => ({ videos: feeds.get(id), error: null }) });
  db.close();
  const old = new DatabaseSync(file);
  old.exec(`ALTER TABLE videos DROP COLUMN announce; PRAGMA user_version = 2;
    UPDATE videos SET notified_at = '2026-11-17T08:00:00.000Z' WHERE id = 'fav00000002'`);
  old.close();

  const upgraded = openDb(file);
  assert.deepEqual(upgraded.uploadsToAnnounce(), []);
  feeds.get(FAV).push(video('fav00000004', FAV, 4));
  const sent = [];
  await refreshFeeds(upgraded, [FAV], { fetchFeeds: async (id) => ({ videos: feeds.get(id), error: null }), announce: () => true });
  assert.equal(await notifyNewUploads({ db: upgraded, send: async (m) => void sent.push(m.body) }), 1);
  assert.deepEqual(sent, ['Title of fav00000004']);
  upgraded.close();
  const raw = new DatabaseSync(file);
  const rows = raw.prepare("SELECT id, announce, notified_at FROM videos WHERE id IN ('fav00000002', 'fav00000003') ORDER BY id").all();
  raw.close();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { id: 'fav00000002', announce: 0, notified_at: '2026-11-17T08:00:00.000Z' },
    { id: 'fav00000003', announce: 0, notified_at: null },
  ]);
});

test('more than 10 new uploads in one refresh send one summary', async () => {
  const { feeds, sent, refresh } = setup();
  await refresh();
  for (let n = 2; n <= 13; n++) feeds.get(FAV).push(video(`fav000000${String(n).padStart(2, '0')}`, FAV, n));
  assert.equal(await refresh(), 1);
  assert.deepEqual(sent, [{ title: '12 new videos', body: 'From Favorite Channel', tags: 'tv' }]);
  assert.equal(await refresh(), 0);
});

test('a failed message is not marked as sent and does not stop the others', async () => {
  const { db, feeds, refresh } = setup();
  await refresh();
  feeds.get(FAV).push(video('fav00000002', FAV, 2), video('fav00000003', FAV, 3));
  await refreshFeeds(db, [FAV], { fetchFeeds: async (id) => ({ videos: feeds.get(id), error: null }), announce: () => true });
  const sent = [];
  const flaky = async (m) => {
    if (m.body.endsWith('02')) throw new Error('ntfy down');
    sent.push(m.body);
  };
  assert.equal(await notifyNewUploads({ db, send: flaky }), 1);
  assert.deepEqual(sent, ['Title of fav00000003']);
  assert.deepEqual(db.uploadsToAnnounce().map((u) => u.id), ['fav00000002']);
});

test('an announce run under a fixed clock sends the uploads stored in the 24 hours before it, on any day', async () => {
  let clock = new Date('2026-11-15T12:00:00Z');
  const db = openDb(':memory:', { now: () => clock });
  db.subscribeChannel({ id: FAV, name: 'Favorite Channel' }, []);
  db.updateChannel(FAV, { favorite: true });
  db.upsertVideos([video('fav00000001', FAV, 1)], { announce: true });
  clock = new Date('2026-11-16T11:00:00Z');
  db.upsertVideos([video('fav00000002', FAV, 2)], { announce: true });
  clock = new Date('2026-11-16T13:00:00Z');
  const sent = [];
  assert.equal(await notifyNewUploads({ db, send: async (m) => void sent.push(m.body) }), 1);
  assert.deepEqual(sent, ['Title of fav00000002'], 'the upload stored 25 hours earlier is dropped');
});

test('ntfySender posts the message with ntfy headers and a bearer token', async () => {
  const requests = [];
  const send = ntfySender({
    topicUrl: 'https://ntfy.example/subfeed',
    token: 'tk_secret',
    fetchImpl: async (url, init) => (requests.push({ url, ...init }), new Response('{}')),
  });
  await send({ title: 'Čebelar Žan', body: 'Panjski 🐝 video', click: 'https://www.youtube.com/watch?v=abc', attach: 'https://i.ytimg.com/a.jpg', tags: 'tv' });
  await send({ title: 'subfeed backup failed', body: 'disk full', priority: 'high', tags: 'warning' });
  const [video, alert] = requests;
  assert.equal(video.url, 'https://ntfy.example/subfeed');
  assert.equal(video.method, 'POST');
  assert.equal(video.body, 'Panjski 🐝 video');
  assert.deepEqual(video.headers, {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: `=?UTF-8?B?${Buffer.from('Čebelar Žan').toString('base64')}?=`,
    Click: 'https://www.youtube.com/watch?v=abc',
    Attach: 'https://i.ytimg.com/a.jpg',
    Tags: 'tv',
    Authorization: 'Bearer tk_secret',
  });
  assert.equal(alert.headers.Title, 'subfeed backup failed');
  assert.equal(alert.headers.Priority, 'high');

  const failing = ntfySender({ topicUrl: 'https://ntfy.example/subfeed', fetchImpl: async () => new Response('no', { status: 403 }) });
  await assert.rejects(failing({ title: 't', body: 'b' }), /HTTP 403/);
});

// A server over `file` whose ntfy can be taken down; `refresh()` runs the refresh of every channel.
function server(file, feeds) {
  const db = openDb(file);
  const ntfy = { up: true, sent: [] };
  const notify = async (m) => {
    if (!ntfy.up) throw new Error('ntfy down');
    ntfy.sent.push(m.body);
  };
  const app = testApp({ db, notify, fetchFeeds: async (id) => ({ videos: feeds.get(id) ?? [], error: null }) });
  return { db, ntfy, refresh: () => app.refresh() };
}

test('a new upload whose message failed is sent exactly once by the next refresh', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-notify-')), 'subfeed.db');
  const { db, feeds } = setup(file);
  db.close();
  const s = server(file, feeds);
  await s.refresh();
  feeds.get(FAV).push(video('new00000000', FAV, 2));
  s.ntfy.up = false;
  await s.refresh();
  assert.deepEqual(s.ntfy.sent, []);
  s.ntfy.up = true;
  await s.refresh();
  assert.deepEqual(s.ntfy.sent, ['Title of new00000000']);
  await s.refresh();
  assert.deepEqual(s.ntfy.sent, ['Title of new00000000'], 'a later refresh sends it no more');
});

test('a new server on the same database sends an upload stored but not announced before the restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-notify-')), 'subfeed.db');
  const { db, feeds } = setup(file);
  db.close();
  const before = server(file, feeds);
  await before.refresh();
  feeds.get(FAV).push(video('new00000000', FAV, 2));
  before.ntfy.up = false;
  await before.refresh();
  before.db.close();

  const after = server(file, feeds);
  await after.refresh();
  assert.deepEqual(after.ntfy.sent, ['Title of new00000000']);
});

test('a video a backfill stored is never sent, by a later refresh or a new server', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-notify-')), 'subfeed.db');
  const { db, feeds } = setup(file);
  db.close();
  const s = server(file, feeds);
  await s.refresh();
  const api = fetchApi('k', async (url) => {
    const endpoint = new URL(url).pathname.split('/').pop();
    if (endpoint === 'videos') return Response.json({ items: [{ id: 'backfill001', contentDetails: { duration: 'PT20M' }, snippet: { liveBroadcastContent: 'none' } }] });
    const playlist = new URL(url).searchParams.get('playlistId');
    if (playlist.startsWith('UUSH')) return Response.json({ error: { message: 'none', errors: [{ reason: 'playlistNotFound' }] } }, { status: 404 });
    return Response.json({ items: [{ snippet: { title: 'Older upload', thumbnails: {} }, contentDetails: { videoId: 'backfill001', videoPublishedAt: '2026-11-15T12:05:00Z' } }] });
  });
  await backfillChannel({ id: FAV, name: 'Favorite Channel' }, { api, db: s.db });
  await s.refresh();
  s.db.close();
  const after = server(file, feeds);
  await after.refresh();
  assert.deepEqual([...s.ntfy.sent, ...after.ntfy.sent], []);
});

test('an upload first stored more than 24 hours ago is not sent', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T12:00:00Z') });
  const { db, feeds, sent, refresh } = setup();
  await refresh();
  feeds.get(FAV).push(video('fav00000002', FAV, 2));
  const failing = async () => { throw new Error('ntfy down'); };
  await refreshFeeds(db, [FAV], { fetchFeeds: async (id) => ({ videos: feeds.get(id), error: null }), announce: () => true });
  assert.equal(await notifyNewUploads({ db, send: failing }), 0);
  t.mock.timers.tick(24 * 3600_000 - 1);
  assert.deepEqual(db.uploadsToAnnounce().map((u) => u.id), ['fav00000002']);
  t.mock.timers.tick(2);
  assert.equal(await refresh(), 0);
  assert.deepEqual(sent, []);
});

test('an upload stored before its channel became a favorite is never sent', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-notify-')), 'subfeed.db');
  const { db, feeds } = setup(file);
  db.close();
  const s = server(file, feeds);
  await s.refresh();
  feeds.get(OTHER).push(video('oth00000002', OTHER, 2));
  await s.refresh();
  s.db.updateChannel(OTHER, { favorite: true });
  await s.refresh();
  assert.deepEqual(s.ntfy.sent, []);
  feeds.get(OTHER).push(video('oth00000003', OTHER, 3));
  await s.refresh();
  assert.deepEqual(s.ntfy.sent, ['Title of oth00000003']);
});
