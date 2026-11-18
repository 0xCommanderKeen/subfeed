import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AVATAR_PAGES_PER_REFRESH, fillMissingAvatars } from '../src/avatars.mjs';
import { openDb } from '../src/db.mjs';
import { MAX_PER_CALL } from '../src/youtube-api.mjs';

const page = readFileSync(join(import.meta.dirname, 'fixtures', 'channel-page.html'), 'utf8');
const PAGE_AVATAR = 'https://yt3.googleusercontent.com/fixture=s240-c-k?a&b';
const channelId = (n) => `UC${String(n).padStart(22, '0')}`;

function dbWith(count) {
  const db = openDb(':memory:');
  for (let n = 0; n < count; n++) db.subscribeChannel({ id: channelId(n), name: `Channel ${n}`, handle: null }, []);
  return db;
}

const avatars = (db) => Object.fromEntries(db.listChannels().map((c) => [c.id, c.avatar]));

test('subscribeChannel stores the avatar, and adding the channel again without one keeps it', () => {
  const db = openDb(':memory:');
  db.subscribeChannel({ id: channelId(0), name: 'A', handle: null, avatar: 'https://yt3/a' }, []);
  db.subscribeChannel({ id: channelId(0), name: 'A', handle: null, avatar: null }, []);
  assert.equal(db.listChannels()[0].avatar, 'https://yt3/a');
  assert.deepEqual(db.channelsMissingAvatar(10), []);
});

test('with a key, one channels.list call fills up to 50 channels, and a channel with no picture is not asked again', async () => {
  const db = dbWith(MAX_PER_CALL + 3);
  db.updateChannel(channelId(1), { subscribed: false });
  const calls = [];
  const api = async (endpoint, params) => {
    calls.push([endpoint, params]);
    const ids = params.id.split(',').filter((id) => id !== channelId(2));
    return { items: ids.map((id) => ({ id, snippet: { thumbnails: { medium: { url: `https://yt3/${id}` } } } })) };
  };

  assert.equal(await fillMissingAvatars({ db, api }), MAX_PER_CALL);
  assert.equal(calls.length, 1);
  const asked = calls[0][1].id.split(',');
  assert.equal(asked.length, MAX_PER_CALL);
  assert.ok(!asked.includes(channelId(1)), 'unsubscribed channels are skipped');
  const after = avatars(db);
  assert.equal(after[channelId(0)], `https://yt3/${channelId(0)}`);
  assert.equal(after[channelId(2)], null, 'no picture falls back to the monogram');

  assert.equal(await fillMissingAvatars({ db, api }), 2);
  assert.deepEqual(calls[1][1].id.split(','), [channelId(51), channelId(52)]);
  assert.equal(await fillMissingAvatars({ db, api }), 0);
  assert.equal(calls.length, 2, 'nothing left to look up makes no call');
});

test('without a key, a few channel pages per refresh; a missing channel is settled, a consent page or error is retried', async () => {
  const db = dbWith(AVATAR_PAGES_PER_REFRESH + 4);
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.endsWith(channelId(1))) return new Response('', { status: 404 });
    if (url.endsWith(channelId(2))) return new Response('<html>consent</html>', { status: 200 });
    if (url.endsWith(channelId(3))) throw new Error('timeout');
    return new Response(page, { status: 200 });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await fillMissingAvatars({ db, fetchImpl }), AVATAR_PAGES_PER_REFRESH - 2);
  } finally {
    console.warn = warn;
  }
  assert.equal(urls.length, AVATAR_PAGES_PER_REFRESH);
  assert.equal(urls[0], `https://www.youtube.com/channel/${channelId(0)}`);
  assert.equal(avatars(db)[channelId(0)], PAGE_AVATAR);
  assert.deepEqual(db.channelsMissingAvatar(100), [channelId(2), channelId(3), ...[10, 11, 12, 13].map(channelId)]);
});
