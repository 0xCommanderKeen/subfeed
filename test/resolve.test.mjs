import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApiError } from '../src/youtube-api.mjs';
import { parseApiChannel, parseApiVideo, parseChannelInput, parseChannelPage, parseWatchPage, resolveChannel, resolveVideo } from '../src/resolve.mjs';

const ID = 'UCiczXOhGpvoQGhOL16EZiTg';
const page = readFileSync(join(import.meta.dirname, 'fixtures', 'channel-page.html'), 'utf8');
const apiBody = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'channels-list.json'), 'utf8'));

test('parseChannelInput accepts handles and channel URLs', () => {
  const handle = { kind: 'handle', handle: '@CNCKitchen' };
  const id = { kind: 'id', id: ID };
  const cases = [
    ['@CNCKitchen', handle],
    ['CNCKitchen', handle],
    ['  @CNCKitchen\n', handle],
    ['https://www.youtube.com/@CNCKitchen', handle],
    ['https://www.youtube.com/@CNCKitchen/videos?view=0', handle],
    ['youtube.com/@CNCKitchen', handle],
    ['http://m.youtube.com/@CNCKitchen', handle],
    ['https://music.youtube.com/@CNCKitchen', handle],
    ['music.youtube.com/@CNCKitchen', handle],
    ['https://www.youtube.com/@Caf%C3%A9Maker', { kind: 'handle', handle: '@CaféMaker' }],
    ['@made.with-layers_3d', { kind: 'handle', handle: '@made.with-layers_3d' }],
    [`https://www.youtube.com/channel/${ID}`, id],
    [`https://www.youtube.com/channel/${ID}/featured`, id],
    [`https://music.youtube.com/channel/${ID}`, id],
    [ID, id],
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseChannelInput(input), expected, input);
});

test('parseChannelInput rejects everything else', () => {
  for (const input of ['', '   ', '@', '@ab', 'has space', '@a/b', 'https://example.com/@CNCKitchen', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/channel/UCshort', 'https://www.youtube.com/c/CNCKitchen', 'x'.repeat(31), null, undefined]) {
    assert.equal(parseChannelInput(input), null, String(input));
  }
});

const API_AVATAR = 'https://yt3.ggpht.com/fixture=s88';
const PAGE_AVATAR = 'https://yt3.googleusercontent.com/fixture=s240-c-k?a&b';

test('parseApiChannel reads id and title, keeping the typed handle or using customUrl for an id lookup', () => {
  assert.deepEqual(parseApiChannel(apiBody, { kind: 'handle', handle: '@CNCKitchen' }), { id: ID, name: 'CNC Kitchen', handle: '@CNCKitchen', avatar: API_AVATAR });
  assert.deepEqual(parseApiChannel(apiBody, { kind: 'id', id: ID }), { id: ID, name: 'CNC Kitchen', handle: '@cnckitchen', avatar: API_AVATAR });
  assert.equal(parseApiChannel({ items: [{ id: ID, snippet: { title: 'x', customUrl: 'cnckitchen' } }] }, { kind: 'id', id: ID }).handle, '@cnckitchen');
  const sized = { items: [{ id: ID, snippet: { title: 'x', thumbnails: { default: { url: 's88' }, medium: { url: 's240' }, high: { url: 's800' } } } }] };
  assert.equal(parseApiChannel(sized, { kind: 'id', id: ID }).avatar, 's240', 'prefers the medium picture');
  assert.equal(parseApiChannel({ items: [{ id: ID, snippet: { title: 'x' } }] }, { kind: 'id', id: ID }).avatar, null);
  assert.equal(parseApiChannel({ kind: 'youtube#channelListResponse', pageInfo: { totalResults: 0 } }, { kind: 'id', id: ID }), null);
});

test('parseChannelPage reads externalId, og:title, og:image and the vanity handle', () => {
  assert.deepEqual(parseChannelPage(page, { kind: 'id', id: ID }), { id: ID, name: 'CNC Kitchen & Friends', handle: '@CNCKitchen', avatar: PAGE_AVATAR });
  assert.equal(parseChannelPage('<html>consent</html>', { kind: 'handle', handle: '@x' }), null);
});

function fakeFetch(responses) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const { status, body } = responses[url] ?? { status: 404, body: '' };
    return new Response(body, { status });
  };
  return { urls, fetchImpl };
}

test('resolveChannel uses the API, trusts its empty answer, and falls back to the page on an API error', async () => {
  const ref = { kind: 'handle', handle: '@CNCKitchen' };
  const calls = [];
  const api = async (endpoint, params) => (calls.push([endpoint, params]), apiBody);
  const { urls, fetchImpl } = fakeFetch({ 'https://www.youtube.com/@CNCKitchen': { status: 200, body: page } });

  assert.deepEqual(await resolveChannel(ref, { api, fetchImpl }), { id: ID, name: 'CNC Kitchen', handle: '@CNCKitchen', avatar: API_AVATAR });
  assert.deepEqual(calls, [['channels', { part: 'snippet', forHandle: '@CNCKitchen' }]]);
  assert.deepEqual(urls, [], 'no page fetch when the API answers');

  assert.equal(await resolveChannel(ref, { api: async () => ({ items: [] }), fetchImpl }), null);
  assert.deepEqual(urls, []);

  const quota = async () => {
    throw new ApiError(403, 'quotaExceeded', 'quota');
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await resolveChannel(ref, { api: quota, fetchImpl }), { id: ID, name: 'CNC Kitchen & Friends', handle: '@CNCKitchen', avatar: PAGE_AVATAR });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(urls, ['https://www.youtube.com/@CNCKitchen']);
});

test('resolveChannel without a key reads the channel page; a 404 page means no channel', async () => {
  const { urls, fetchImpl } = fakeFetch({ [`https://www.youtube.com/channel/${ID}`]: { status: 200, body: page } });
  assert.equal((await resolveChannel({ kind: 'id', id: ID }, { fetchImpl })).id, ID);
  assert.equal(await resolveChannel({ kind: 'handle', handle: '@nobody' }, { fetchImpl }), null);
  assert.deepEqual(urls, [`https://www.youtube.com/channel/${ID}`, 'https://www.youtube.com/@nobody']);
});

const RICK = 'UCuAXFkgsw1L7xaCfnd5JJOw';
const watchPage = readFileSync(join(import.meta.dirname, 'fixtures', 'watch-page.html'), 'utf8');
const pageVideo = {
  id: 'dQw4w9WgXcQ',
  channelId: RICK,
  channelName: 'Rick Astley',
  title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
  published: '2009-10-25T06:57:33.000Z',
  thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  isShort: false,
  views: 1838086586,
  durationS: 213,
  kind: null,
};

test('parseWatchPage reads the channel, title, date, length and views; a page without a video gives null', () => {
  assert.deepEqual(parseWatchPage(watchPage, 'dQw4w9WgXcQ', false), pageVideo);
  assert.equal(parseWatchPage(watchPage.replace('"lengthSeconds":"213"', '"lengthSeconds":"0"'), 'dQw4w9WgXcQ', true).durationS, null, 'a live video has no length yet');
  assert.equal(parseWatchPage('<html><title>YouTube</title></html>', 'dQw4w9WgXcQ', false), null);
});

const apiVideo = {
  items: [{
    id: 'dQw4w9WgXcQ',
    snippet: {
      channelId: RICK,
      channelTitle: 'Rick Astley',
      title: 'Never Gonna Give You Up',
      publishedAt: '2009-10-25T06:57:33Z',
      liveBroadcastContent: 'none',
      thumbnails: { high: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' } },
    },
    contentDetails: { duration: 'PT3M33S' },
    statistics: { viewCount: '42' },
  }],
};

test('parseApiVideo reads a videos.list item with its kind and length', () => {
  assert.deepEqual(parseApiVideo(apiVideo, false), { ...pageVideo, title: 'Never Gonna Give You Up', views: 42, kind: 'video' });
  assert.equal(parseApiVideo(apiVideo, true).kind, 'short');
  assert.equal(parseApiVideo({ items: [] }, false), null);
});

test('resolveVideo uses the API with a key and the watch page without one', async () => {
  const calls = [];
  const api = async (endpoint, params) => (calls.push([endpoint, params.id]), apiVideo);
  const { urls, fetchImpl } = fakeFetch({ 'https://www.youtube.com/watch?v=dQw4w9WgXcQ': { status: 200, body: watchPage } });
  assert.equal((await resolveVideo('dQw4w9WgXcQ', false, { api, fetchImpl })).kind, 'video');
  assert.deepEqual(calls, [['videos', 'dQw4w9WgXcQ']]);
  assert.deepEqual(urls, []);
  assert.deepEqual(await resolveVideo('dQw4w9WgXcQ', false, { fetchImpl }), pageVideo);
  assert.deepEqual(urls, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
});
