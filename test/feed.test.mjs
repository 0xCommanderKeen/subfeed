import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.mjs';
import { fetchChannelFeeds } from '../src/feed.mjs';
import { refreshFeeds } from '../src/refresh.mjs';
import { feedVideo } from './helpers.mjs';

const CHANNEL = 'UCKxAfFTFQFYJrwdCl4PlGpg';
const ENTRY = `<feed><entry><yt:videoId>abcdefghijk</yt:videoId><title>One</title><published>2026-11-01T00:00:00+00:00</published>
<media:thumbnail url="https://i.ytimg.com/x.jpg"/><media:statistics views="5"/></entry></feed>`;

// `routes` maps a feed query (playlist_id=… or channel_id=…) to [status, body]; anything else is a 404.
const fakeFetch = (routes) => async (url) => {
  const [status, body = '<feed></feed>'] = routes[new URL(url).search.slice(1)] ?? [404];
  return new Response(body, { status });
};

test('an RSS entry carries its decoded description, and an entry without one has none', async () => {
  const described = ENTRY.replace('<media:thumbnail', '<media:description>PETG &amp; PLA\ncompared</media:description><media:thumbnail');
  const routes = { [`playlist_id=UULF${CHANNEL.slice(2)}`]: [200, described], [`playlist_id=UUSH${CHANNEL.slice(2)}`]: [200, ENTRY] };
  const r = await fetchChannelFeeds(CHANNEL, 1000, fakeFetch(routes));
  assert.deepEqual(r.videos.map((v) => v.description), ['PETG & PLA\ncompared', null]);
});

test('the live streams playlist is read along with its videos and Shorts', async () => {
  const stream = ENTRY.replace('abcdefghijk', 'livestream1');
  const routes = { [`playlist_id=UULF${CHANNEL.slice(2)}`]: [200, ENTRY], [`playlist_id=UULV${CHANNEL.slice(2)}`]: [200, stream] };
  const r = await fetchChannelFeeds(CHANNEL, 1000, fakeFetch(routes));
  assert.equal(r.error, null);
  assert.deepEqual(r.videos.map((v) => [v.id, v.isShort]), [['abcdefghijk', false], ['livestream1', false]]);
});

test('a channel with no uploads playlists but a live channel feed is empty, not failed', async () => {
  const r = await fetchChannelFeeds(CHANNEL, 1000, fakeFetch({ [`channel_id=${CHANNEL}`]: [200] }));
  assert.deepEqual(r, { videos: [], error: null });
});

test('a channel whose channel feed is also 404 is reported as not found', async () => {
  const r = await fetchChannelFeeds(CHANNEL, 1000, fakeFetch({}));
  assert.deepEqual(r, { videos: [], error: 'channel not found (HTTP 404)' });
});

test('a failing channel feed is reported with its status', async () => {
  const r = await fetchChannelFeeds(CHANNEL, 1000, fakeFetch({ [`channel_id=${CHANNEL}`]: [500] }));
  assert.equal(r.error, 'HTTP 500');
});

test('a channel with long videos and no Shorts playlist loads without an error and never asks the channel feed', async () => {
  const asked = [];
  const routes = { [`playlist_id=UULF${CHANNEL.slice(2)}`]: [200, ENTRY] };
  const r = await fetchChannelFeeds(CHANNEL, 1000, (url, init) => (asked.push(url), fakeFetch(routes)(url, init)));
  assert.equal(r.error, null);
  assert.deepEqual(r.videos.map((v) => [v.id, v.isShort]), [['abcdefghijk', false]]);
  assert.ok(!asked.some((u) => u.includes('channel_id=')));
});

test('malformed entries are skipped and counted, and two refreshes store only the good entry', async () => {
  const entry = ({ id = '<yt:videoId>goodvideo01</yt:videoId>', title = '<title>Good</title>', published = '<published>2026-11-01T00:00:00+00:00</published>' }) =>
    `<entry>${id}${title}${published}<media:thumbnail url="https://i.ytimg.com/x.jpg"/></entry>`;
  const xml = `<feed>${[
    entry({}),
    entry({ id: '<yt:videoId>nopublish01</yt:videoId>', published: '' }),
    entry({ id: '<yt:videoId>notitle0001</yt:videoId>', title: '' }),
    entry({ id: '<yt:videoId>badpoint001</yt:videoId>', title: '<title>Bad &#x110000; point</title>' }),
    entry({ id: '' }),
  ].join('')}</feed>`;
  const routes = { [`playlist_id=UULF${CHANNEL.slice(2)}`]: [200, xml] };
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-')), 'feed.db');
  const db = openDb(file);
  db.subscribeChannel({ id: CHANNEL, name: 'C' }, []);
  const errors = [];
  for (let i = 0; i < 2; i++) {
    await refreshFeeds(db, [CHANNEL], { fetchFeeds: (id) => fetchChannelFeeds(id, 1000, fakeFetch(routes)), onChannel: (_, error) => errors.push(error) });
  }
  db.close();
  const rows = new DatabaseSync(file).prepare('SELECT id, title FROM videos ORDER BY id').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { id: 'badpoint001', title: 'Bad &#x110000; point' },
    { id: 'goodvideo01', title: 'Good' },
  ]);
  assert.deepEqual(errors, ['skipped 3 malformed feed entries', 'skipped 3 malformed feed entries']);
});

test('upsertVideos refuses a video without a valid id', () => {
  const db = openDb(':memory:');
  db.subscribeChannel({ id: CHANNEL, name: 'C' }, []);
  const video = feedVideo({ channelId: CHANNEL, title: 't', published: '2026-11-01T00:00:00.000Z' });
  const { insertedIds } = db.upsertVideos([{ ...video, id: undefined }, { ...video, id: 'short' }, { ...video, id: 'goodvideo01' }]);
  assert.deepEqual(insertedIds, ['goodvideo01']);
});

test('a feed request that times out once is asked again and the channel loads without an error', async () => {
  const routes = { [`playlist_id=UULF${CHANNEL.slice(2)}`]: [200, ENTRY] };
  const asked = [];
  const timingOutOnce = async (url, init) => {
    asked.push(url);
    if (asked.filter((u) => u === url).length === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return fakeFetch(routes)(url, init);
  };
  const r = await fetchChannelFeeds(CHANNEL, 1000, timingOutOnce);
  assert.equal(r.error, null);
  assert.deepEqual(r.videos.map((v) => v.id), ['abcdefghijk']);
});

test('a feed request that times out twice reports the timeout', async () => {
  const timingOut = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const r = await fetchChannelFeeds(CHANNEL, 1000, timingOut);
  assert.equal(r.error, 'The operation was aborted due to timeout');
});
