import assert from 'node:assert/strict';
import { test } from 'node:test';
import { videoUrl } from '../src/feed.mjs';
import { findChannel, findGroup, formatLength, parseSince, subfeedTools, videoIdFrom, videoLine } from '../src/mcp-tools.mjs';
import { buildGroups } from '../public/groups.js';
import { formatAge } from '../public/vocab.js';
import { feedVideo, startApp } from './helpers.mjs';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');
const TT = 'UCtttttttttttttttttttttt';
const TX = 'UCxxxxxxxxxxxxxxxxxxxxxx';
const BB = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const CC = 'UCcccccccccccccccccccccc';

const TOPICS = [{ id: 'print', name: '3D Printing', hidden: false }, { id: 'bb', name: 'Blood Bowl', hidden: false }, { id: 'cafe', name: 'Café Racers', hidden: false }];
const CHANNELS = [
  { id: TT, name: 'Teaching Tech', handle: '@TeachingTech', topics: ['print'], favorite: false },
  { id: TX, name: 'Teaching Tech Extra', handle: null, topics: ['print'], favorite: false },
  { id: BB, name: 'Bonehead Podcast', handle: '@BoneheadPodcast', topics: ['bb'], favorite: true },
];

const video = (n, extra = {}) =>
  feedVideo({ id: `vid${String(n).padStart(8, '0')}`, channelId: TT, title: `Video ${n}`, published: new Date(Date.now() - n * HOUR).toISOString(), durationS: 600, ...extra });

async function start(t, { videos = [], visits = {}, ...opts } = {}) {
  const s = await startApp(t, opts);
  for (const { id, name } of TOPICS) s.db.ensureTopic(id, name);
  for (const { id, name, handle, topics, favorite } of CHANNELS) {
    s.db.subscribeChannel({ id, name, handle }, topics);
    if (favorite) s.db.updateChannel(id, { favorite });
  }
  s.db.upsertVideos(videos);
  for (const [group, seenAt] of Object.entries(visits)) s.db.markVisit(group, seenAt);
  return s;
}

const titles = (text) => text.split('\n').slice(1).map((l) => l.split(' · ')[0]);

test('a video line has the star, title, channel, age, length and URL', () => {
  const v = { id: 'abcdefghijk', title: 'Input shaping', channelName: 'Teaching Tech', published: new Date(NOW - 3 * HOUR).toISOString(), isShort: false, url: videoUrl('abcdefghijk', false) };
  assert.equal(videoLine({ ...v, favorite: true, durationS: 3725, kind: 'video' }, NOW), '★ Input shaping · Teaching Tech · 3h · 1:02:05 · https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(videoLine({ ...v, favorite: false, durationS: null, kind: null }, NOW), 'Input shaping · Teaching Tech · 3h · https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(formatLength({ kind: 'video', durationS: 59 }), '0:59');
  assert.equal(formatLength({ kind: 'video', durationS: 600 }), '10:00');
  assert.equal(formatLength({ kind: 'upcoming', durationS: null }), 'upcoming');
  assert.equal(formatLength({ kind: 'live', durationS: null }), 'live');
  const ago = (ms) => formatAge(new Date(NOW - ms).toISOString(), NOW);
  assert.deepEqual([ago(5 * 60_000), ago(3 * HOUR), ago(2 * 24 * HOUR), ago(3 * 7 * 24 * HOUR), ago(125 * 24 * HOUR), ago(800 * 24 * HOUR)], ['5m', '3h', '2d', '3w', '4mo', '2y']);
});

test('since takes an ISO date or a span back from now', () => {
  assert.equal(parseSince('24h', NOW), '2026-11-15T12:00:00.000Z');
  assert.equal(parseSince('7d', NOW), '2026-11-09T12:00:00.000Z');
  assert.equal(parseSince('2W', NOW), '2026-11-02T12:00:00.000Z');
  assert.equal(parseSince('2026-11-01', NOW), '2026-11-01T00:00:00.000Z');
  assert.equal(parseSince('2026-11-01T08:30:00+01:00', NOW), '2026-11-01T07:30:00.000Z');
  for (const bad of ['yesterday', '7', '3mo', '2026-13-45', '']) assert.throws(() => parseSince(bad, NOW), /since must be/, bad);
  assert.equal(parseSince('520w', NOW), '2016-11-28T12:00:00.000Z');
  for (const far of ['99999999999w', '3651d', '87601h']) assert.throws(() => parseSince(far, NOW), /since can reach back at most 10 years/, far);
});

test('a video id comes from the id itself or any YouTube URL form', () => {
  for (const input of [
    'dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    'youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'www.youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/v/dQw4w9WgXcQ',
  ]) assert.equal(videoIdFrom(input), 'dQw4w9WgXcQ', input);
  for (const input of ['dQw4w9WgXc', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/@TeachingTech', 'not a url',
    'https://www.youtube.com/playlist?list=PL1&v=dQw4w9WgXcQ']) {
    assert.equal(videoIdFrom(input), null, input);
  }
});

test('a group is found by id, bare topic id, or name in any case and accents', () => {
  const groups = buildGroups({ topics: TOPICS, channels: CHANNELS, visits: {} });
  const id = (input) => findGroup(groups, input).id;
  assert.equal(id('all'), 'all');
  assert.equal(id('topic:bb'), 'topic:bb');
  assert.equal(id('bb'), 'topic:bb');
  assert.equal(id('blood bowl'), 'topic:bb');
  assert.equal(id('CAFE RACERS'), 'topic:cafe');
  assert.equal(id('Everything'), 'all');
  assert.equal(id('★ Videos'), 'favorites');
  assert.equal(id('favorite channels'), 'favorite-channels');
  assert.throws(() => findGroup(groups, 'Minecraft'), /Unknown group "Minecraft"\. The groups are: all \(Everything\), topic:print \(3D Printing\).*favorites \(★ Videos\)/);
  const clash = buildGroups({ topics: [{ id: 'chan', name: 'Channels', hidden: false }], channels: CHANNELS, visits: {} });
  assert.throws(() => findGroup(clash, 'channels'), /Ambiguous group "channels"\. It could be: topic:chan \(Channels\), favorite-channels \(★ Channels\)$/);
});

test('a channel is found by id, handle or name, and an ambiguous or unknown one names the candidates', () => {
  const id = (input) => findChannel(CHANNELS, input).id;
  assert.equal(id(TX), TX);
  assert.equal(id('@teachingtech'), TT);
  assert.equal(id('BoneheadPodcast'), BB);
  assert.equal(id('teaching tech'), TT, 'an exact name wins over a longer name that contains it');
  assert.equal(id('bonehead'), BB);
  assert.throws(() => findChannel(CHANNELS, 'teaching'), /^Error: "teaching" matches several channels: Teaching Tech \(@TeachingTech\), Teaching Tech Extra \(UCx+\)$/);
  assert.throws(() => findChannel(CHANNELS, 'CNC Kitchen'), /No subscribed channel matches "CNC Kitchen"\. The channels are: Teaching Tech .*Bonehead Podcast/);
});

test('new_videos lists the videos after the last visit, newest first, in one query without paging', async (t) => {
  const visit = new Date(Date.now() - 7.5 * HOUR).toISOString();
  const s = await start(t, { videos: Array.from({ length: 20 }, (_, i) => video(i + 1)), visits: { 'topic:print': visit } });
  const paged = t.mock.method(s.db, 'listVideos');
  const out = await s.mcp('new_videos', { group: '3D Printing' });
  assert.match(out, /^7 new in 3D Printing since .* \(last visit\):\n/);
  assert.deepEqual(titles(out), ['Video 1', 'Video 2', 'Video 3', 'Video 4', 'Video 5', 'Video 6', 'Video 7']);
  assert.match(await s.mcp('new_videos', { group: '3D Printing', since: '2h' }), /^1 new in 3D Printing since \S+:\nVideo 1 · /);
  assert.equal(paged.mock.callCount(), 0);
});

test('list_groups only counts, and counts every unvisited group from the same baseline while the clock ticks', async (t) => {
  let at = NOW;
  const s = await start(t, { now: () => new Date((at += 1)) });
  const asked = t.mock.method(s.db, 'newVideos');
  await s.mcp('list_groups');
  const queries = asked.mock.calls.map((c) => c.arguments[0]);
  assert.ok(queries.length > 1);
  assert.ok(queries.every((q) => q.limit === 0), 'list_groups only counts');
  assert.equal(new Set(queries.map((q) => q.since)).size, 1, 'one baseline for all groups');
});

test('new_videos under a fixed clock gives the same answer on any day', async (t) => {
  const ago = (h) => new Date(NOW - h * HOUR).toISOString();
  const s = await start(t, { now: () => new Date(NOW), videos: [video(2, { published: ago(2) }), video(30, { published: ago(30) }), video(100, { published: ago(100) })] });
  const line = (n, age) => `Video ${n} · Teaching Tech · ${age} · 10:00 · ${videoUrl(`vid${String(n).padStart(8, '0')}`, false)}`;
  assert.equal(await s.mcp('new_videos', { group: 'all', since: '24h' }), ['1 new in Everything since 2026-11-15T12:00:00.000Z:', line(2, '2h')].join('\n'));
  assert.equal(
    await s.mcp('new_videos', { group: 'all' }),
    ['2 new in Everything since 2026-11-13T12:00:00.000Z (3 days ago, no visit yet):', line(2, '2h'), line(30, '1d')].join('\n'),
  );
});

test('new_videos without a visit uses 3 days, shows at most 50, and says how many more', async (t) => {
  const videos = [...Array.from({ length: 60 }, (_, i) => video(i + 1)), video(80, { title: 'Too old' }), video(61, { id: 'shortvideo1', isShort: true, title: 'A Short' })];
  const s = await start(t, { videos });
  const out = (await s.mcp('new_videos', { group: 'all' })).split('\n');
  assert.match(out[0], /^60 new in Everything since .* \(3 days ago, no visit yet\):$/);
  assert.equal(out.length, 1 + 50 + 1);
  assert.deepEqual([out[1].split(' · ')[0], out[50].split(' · ')[0]], ['Video 1', 'Video 50']);
  assert.equal(out.at(-1), '… and 10 more. Call again with offset: 50.');
  assert.ok(!out.some((l) => l.startsWith('A Short')), 'Shorts are left out by default');
  assert.match(await s.mcp('new_videos', { group: 'all', include_shorts: true }), /^61 new/);
  assert.match(await s.mcp('new_videos', { group: 'Blood Bowl' }), /^Nothing new in Blood Bowl since [^\n]*$/);
});

test('list_groups gives channels, long videos and new videos per group', async (t) => {
  const videos = [video(1), video(2), video(30, { channelId: BB }), video(3, { channelId: BB, isShort: true }), video(100, { channelId: TX })];
  const s = await start(t, { videos, visits: { all: new Date(Date.now() - 1.5 * HOUR).toISOString() } });
  for (const n of [1, 30]) s.db.setFavorite(video(n).id, true);
  for (const n of [2, 100]) s.db.enqueue(video(n).id);
  assert.deepEqual((await s.mcp('list_groups')).split('\n'), [
    'all · Everything · 3 channels · 4 videos · 1 new',
    'topic:print · 3D Printing · 2 channels · 3 videos · 2 new',
    'topic:bb · Blood Bowl · 1 channel · 1 video · 1 new',
    'topic:cafe · Café Racers · 0 channels · 0 videos · 0 new',
    'favorite-channels · ★ Channels · 1 channel · 1 video · 1 new',
    'favorites · ★ Videos · 2 videos',
    'watch-later · Watch Later · 2 videos',
  ]);
});

test('search matches the start of title words through the index, reports the total and shows at most 30', async (t) => {
  const videos = [...Array.from({ length: 40 }, (_, i) => video(i + 1, { title: `Input shaping part ${i + 1}` })), video(50, { title: 'Reshaping a bed' })];
  const s = await start(t, { videos });
  const out = (await s.mcp('search', { query: 'shaping input' })).split('\n');
  assert.equal(out[0], '40 in Everything match "shaping input":');
  assert.deepEqual([out.length, out[1].split(' · ')[0], out.at(-1)], [1 + 30 + 1, 'Input shaping part 1', '… and 10 more. Call again with offset: 30.']);
  assert.match(await s.mcp('search', { query: 'SHAP inp' }), /^40 in Everything match "SHAP inp":/);
  assert.equal(await s.mcp('search', { query: 'haping' }), 'No videos in Everything match "haping".');
  assert.equal(await s.mcp('search', { query: 'reshaping' }), `1 in Everything match "reshaping":\nReshaping a bed · Teaching Tech · 2d · 10:00 · ${videoUrl(video(50).id, false)}`);
  assert.equal(await s.mcp('search', { query: 'input', group: 'bb' }), 'No videos in Blood Bowl match "input".');
  await assert.rejects(s.mcp('search', { query: '  ' }), /query must have at least one word/);
  await assert.rejects(s.mcp('search', { query: 'x'.repeat(201) }), /query must be at most 200 characters/);
});

// Follows each "Call again with offset" trailer until the answer has none, and returns every page's video ids.
async function pageThrough(s, name, args) {
  const ids = [];
  let offset = 0;
  for (let pages = 0; pages < 10; pages++) {
    const out = await s.mcp(name, { ...args, offset });
    ids.push(...out.split('\n').slice(1).filter((l) => !l.startsWith('… ')).map((l) => l.match(/v=([\w-]{11})/)[1]));
    const next = out.match(/^… and \d+ more\. Call again with offset: (\d+)\.$/m);
    if (!next) return ids;
    offset = Number(next[1]);
  }
  throw new Error(`still more after 10 pages: ${ids.length} ids`);
}

test('search pages through all 63 matches, best match first, with an offset, without duplicates or gaps', async (t) => {
  const videos = Array.from({ length: 63 }, (_, i) =>
    i % 3 ? video(i + 1, { title: `Upgrade ${i + 1}` }) : video(i + 1, { title: `Part ${i + 1}`, description: 'An upgrade for the printer.' }),
  );
  const s = await start(t, { videos: [...videos, video(70, { title: 'Unrelated' })] });
  const first = (await s.mcp('search', { query: 'upgrade' })).split('\n');
  assert.equal(first[0], '63 in Everything match "upgrade":');
  assert.equal(first.at(-1), '… and 33 more. Call again with offset: 30.');
  const ids = await pageThrough(s, 'search', { query: 'upgrade' });
  assert.equal(ids.length, 63);
  assert.deepEqual(new Set(ids), new Set(videos.map((v) => v.id)));
  const titleMatches = videos.filter((v) => v.title.startsWith('Upgrade')).length;
  assert.ok(ids.slice(0, titleMatches).every((id) => videos.find((v) => v.id === id).title.startsWith('Upgrade')), 'title matches come first, across pages');
  const last = (await s.mcp('search', { query: 'upgrade', offset: 60 })).split('\n');
  assert.deepEqual([last[0], last.length], ['63 in Everything match "upgrade":', 1 + 3]);
  assert.equal(await s.mcp('search', { query: 'upgrade', offset: 63 }), '63 in Everything match "upgrade", none after offset 63.');
});

test('new_videos pages through every new video with an offset, without duplicates or gaps', async (t) => {
  const videos = Array.from({ length: 63 }, (_, i) => video(i + 1, { published: new Date(Date.now() - (i + 1) * 0.5 * HOUR).toISOString() }));
  const s = await start(t, { videos });
  const ids = await pageThrough(s, 'new_videos', { group: 'all' });
  assert.deepEqual(ids, videos.map((v) => v.id), 'newest first, each once');
  const second = (await s.mcp('new_videos', { group: 'all', offset: 50 })).split('\n');
  assert.match(second[0], /^63 new in Everything since /);
  assert.deepEqual(titles(second.join('\n')), Array.from({ length: 13 }, (_, i) => `Video ${51 + i}`));
  assert.match(await s.mcp('new_videos', { group: 'all', offset: 63 }), /^63 new in Everything since .*, none after offset 63\.$/);
});

test('channel_videos lists one channel and checks the limit', async (t) => {
  const s = await start(t, { videos: [video(1), video(2, { channelId: BB, title: 'Bonehead 2' })] });
  assert.deepEqual((await s.mcp('channel_videos', { channel: '@BoneheadPodcast' })).split('\n').map((l) => l.split(' · ')[0]), ['★ Bonehead Podcast (@BoneheadPodcast)', 'Bonehead 2']);
  assert.equal(await s.mcp('channel_videos', { channel: TX }), 'Teaching Tech Extra (UCxxxxxxxxxxxxxxxxxxxxxx) · 0 videos\nNo videos stored.');
  await assert.rejects(s.mcp('channel_videos', { channel: BB, limit: 51 }), /limit must be at most 50/);
});

test('favorite_video and favorite_channel change the stored stars', async (t) => {
  const s = await start(t, { videos: [video(1, { id: 'dQw4w9WgXcQ' })] });
  assert.match(await s.mcp('favorite_video', { video: 'https://youtu.be/dQw4w9WgXcQ' }), /^★ Video 1 · Teaching Tech · 1h · 10:00 · /);
  assert.equal(s.db.getVideo('dQw4w9WgXcQ').favorite, true);
  await assert.rejects(s.mcp('favorite_video', { video: 'https://example.com/x' }), /is not a video id/);
  assert.equal(await s.mcp('favorite_channel', { channel: 'bonehead', favorite: false }), 'Bonehead Podcast is not a favorite channel.');
  assert.equal(s.db.listChannels().find((c) => c.id === BB).favorite, false);
});

test('add_channel subscribes in the named topics and refuses a group that is not a topic', async (t) => {
  const api = async (endpoint) => (endpoint === 'channels' ? { items: [{ id: CC, snippet: { title: 'Channel C' } }] } : { items: [] });
  const fetchFeeds = async (id) => ({ videos: id === CC ? [video(1, { channelId: CC })] : [], error: null });
  const s = await start(t, { api, fetchFeeds });
  await assert.rejects(s.mcp('add_channel', { input: '@chc', groups: ['Minecraft'] }), /Unknown topic "Minecraft"\. The topics are: topic:print \(3D Printing\), topic:bb \(Blood Bowl\), topic:cafe \(Café Racers\)$/);
  await assert.rejects(s.mcp('add_channel', { input: '@chc', groups: ['Everything'] }), /Unknown topic "Everything"/);
  assert.equal(s.db.listChannels().some((c) => c.id === CC), false);
  assert.match(await s.mcp('add_channel', { input: '@chc', groups: ['3d printing', 'bb'] }), /^Added Channel C \(@chc\) in 3D Printing, Blood Bowl\. 1 video stored\./);
  const added = s.db.listChannels().find((c) => c.id === CC);
  assert.deepEqual([added.subscribed, added.topics], [true, ['print', 'bb']]);
  assert.equal(s.db.getVideo(video(1).id).channelId, CC);
});

test('watch_later adds to the end of the real queue, keeps a queued video in place, and removes', async (t) => {
  const s = await start(t, { videos: ['dQw4w9WgXcQ', 'aaaaaaaaaa1', 'aaaaaaaaaa2'].map((id) => video(1, { id, title: id })) });
  const order = () => s.db.listQueue().map((v) => v.id);
  assert.equal(await s.mcp('watch_later', { video: 'aaaaaaaaaa1' }), `aaaaaaaaaa1 · Teaching Tech · 1h · 10:00 · ${videoUrl('aaaaaaaaaa1', false)} · in Watch Later (1st)`);
  assert.match(await s.mcp('watch_later', { video: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }), /^dQw4w9WgXcQ · Teaching Tech · /);
  await s.mcp('watch_later', { video: 'aaaaaaaaaa2', queued: true });
  assert.deepEqual(order(), ['aaaaaaaaaa1', 'dQw4w9WgXcQ', 'aaaaaaaaaa2']);
  await s.mcp('watch_later', { video: 'https://youtu.be/aaaaaaaaaa1' });
  assert.deepEqual(order(), ['aaaaaaaaaa1', 'dQw4w9WgXcQ', 'aaaaaaaaaa2']);
  assert.match(await s.mcp('watch_later', { video: 'dQw4w9WgXcQ', queued: false }), / · not in Watch Later$/);
  assert.deepEqual(order(), ['aaaaaaaaaa1', 'aaaaaaaaaa2']);
  await assert.rejects(s.mcp('watch_later', { video: 'too-short' }), /"too-short" is not a video id or a YouTube video URL/);
  await assert.rejects(s.mcp('watch_later', { video: 'aaaaaaaaaa1', queued: 'no' }), /queued must be true or false/);
  assert.deepEqual(order(), ['aaaaaaaaaa1', 'aaaaaaaaaa2']);
});

test('watch_later says it changes subfeed and can be repeated', () => {
  assert.deepEqual(subfeedTools({}).find((tool) => tool.name === 'watch_later').annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true });
});
