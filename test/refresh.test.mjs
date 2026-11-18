import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { refreshFeeds } from '../src/refresh.mjs';
import { feedVideo } from './helpers.mjs';

const ids = Array.from({ length: 40 }, (_, i) => `UC${String(i).padStart(22, '0')}`);
const video = (channelId, n) =>
  feedVideo({ id: `${channelId.slice(-8)}v${n}`.padStart(11, 'x'), channelId, title: `Video ${n}`, published: new Date(Date.UTC(2026, 10, 15, 12, n)).toISOString() });

test('refresh fetches at most `concurrency` channels at once, reaches every channel, and returns only new uploads of known channels', async () => {
  const db = openDb(':memory:');
  for (const id of ids) db.subscribeChannel({ id, name: id }, []);
  for (const id of ids.slice(0, 20)) db.upsertVideos([video(id, 1)]);
  let inFlight = 0;
  let peak = 0;
  const finished = [];
  const fetchFeeds = async (id) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return { videos: [video(id, 1), video(id, 2)], error: null };
  };
  const uploads = await refreshFeeds(db, ids, { fetchFeeds, onChannel: (id) => finished.push(id), concurrency: 5 });
  assert.equal(peak, 5);
  assert.deepEqual([...finished].sort(), [...ids].sort());
  assert.deepEqual(uploads.sort(), ids.slice(0, 20).map((id) => video(id, 2).id).sort());
});

test('a channel whose write throws is reported, and the refresh still stores and returns every other channel', async () => {
  const db = openDb(':memory:');
  for (const id of ids) db.subscribeChannel({ id, name: id }, []);
  for (const id of ids) db.upsertVideos([video(id, 1)]);
  const broken = ids[3];
  const failing = {
    ...db,
    upsertVideos: (videos) => {
      if (videos[0]?.channelId === broken) throw new Error('database is locked');
      return db.upsertVideos(videos);
    },
  };
  const reports = new Map();
  const fetchFeeds = async (id) => {
    await new Promise((r) => setTimeout(r, 2));
    return { videos: [video(id, 1), video(id, 2)], error: null };
  };
  const uploads = await refreshFeeds(failing, ids, { fetchFeeds, onChannel: (id, error) => reports.set(id, error), concurrency: 5 });
  assert.equal(reports.size, ids.length);
  assert.equal(reports.get(broken), 'database is locked');
  assert.ok(ids.filter((id) => id !== broken).every((id) => reports.get(id) === null));
  const others = ids.filter((id) => id !== broken).map((id) => video(id, 2).id);
  assert.deepEqual(uploads.sort(), others.sort());
});
