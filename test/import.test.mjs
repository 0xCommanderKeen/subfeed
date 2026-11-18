import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_MODEL, backfillUnits, claudeSuggester, keywordSuggestions, parseSubscriptionsCsv } from '../src/import-subs.mjs';
import { feedVideo, startApp, testApp } from './helpers.mjs';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const id = (n) => `UC${String(n).padStart(22, '0')}`;
const KNOWN = id(0);
const csvOf = (ids) => ['Channel Id,Channel Url,Channel Title', ...ids.map((c) => `${c},http://www.youtube.com/channel/${c},Channel ${c.slice(-3)}`)].join('\n');
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

const TOPICS = [
  { id: '3d-printing', name: '3D Printing' },
  { id: 'board-games', name: 'Board Games' },
  { id: 'woodworking', name: 'Woodworking' },
];

async function start(t, { fetchFeeds = async (cid) => ({ videos: [video(cid)], error: null }), ...opts } = {}) {
  const s = await startApp(t, { fetchFeeds, now: () => NOW, ...opts });
  for (const topic of TOPICS) s.db.createTopic(topic.name);
  s.db.subscribeChannel({ id: KNOWN, name: 'Known Printer', handle: '@known' }, ['3d-printing']);
  return s;
}

const video = (channelId) => feedVideo({ id: `v${channelId.slice(-10)}`, channelId, title: 'Latest', published: NOW.toISOString() });

// A fake Data API: channels.list knows every id but `missing`, and backfills record how many run at once.
function fakeApi({ missing = new Set(), describe = () => '' } = {}) {
  const calls = [];
  let running = 0;
  const log = { calls, maxRunning: 0 };
  log.api = async (endpoint, params) => {
    calls.push({ endpoint, ids: params.id?.split(','), playlistId: params.playlistId });
    if (endpoint === 'channels') {
      const items = params.id.split(',').filter((c) => !missing.has(c)).map((c) => ({
        id: c,
        snippet: { title: `Channel ${c.slice(-3)}`, description: describe(c), customUrl: `@ch${c.slice(-3)}`, thumbnails: { medium: { url: `https://yt3.example/${c}` } } },
        statistics: { videoCount: '120' },
      }));
      return { items };
    }
    running++;
    log.maxRunning = Math.max(log.maxRunning, running);
    await flush();
    running--;
    return { items: [] };
  };
  return log;
}

test('parseSubscriptionsCsv reads the Takeout columns, quoted titles and a BOM, and lists each channel once', () => {
  const text = `﻿Channel Id,Channel Url,Channel Title\r\n${id(1)},http://www.youtube.com/channel/${id(1)},"Paint, Glue & ""Games"""\r\n\r\nnot-an-id,x,y\r\n${id(2)},u,Two\r\n${id(1)},u,Again\r\n`;
  assert.deepEqual(parseSubscriptionsCsv(text), [
    { id: id(1), title: 'Paint, Glue & "Games"' },
    { id: id(2), title: 'Two' },
  ]);
  assert.throws(() => parseSubscriptionsCsv('Name,Url\nx,y'), /Channel Id/);
});

test('keyword suggestions match topic words by their stem in the title or description', () => {
  const channels = [
    { name: 'The Printer Guy', description: 'Reviews of every 3D printer' },
    { name: 'Dice Tower', description: 'Board game reviews and Top 10 lists' },
    { name: 'Cooking Daily', description: 'Recipes' },
  ];
  assert.deepEqual(keywordSuggestions(channels, TOPICS), [['3d-printing'], ['board-games'], []]);
});

test('backfill estimate is two units per 50 videos plus the first page of each list', () => {
  assert.equal(backfillUnits(0), 3);
  assert.equal(backfillUnits(120), 9);
  assert.equal(backfillUnits(null), 3);
});

test('preview lists only new channels, looks them up 50 per call, and estimates the backfill units', async (t) => {
  const fresh = Array.from({ length: 60 }, (_, i) => id(i + 1));
  const yt = fakeApi({ missing: new Set([id(60)]), describe: (c) => (c === id(1) ? 'Woodworking projects in my shop' : '') });
  const s = await start(t, { api: yt.api });
  const { status, body } = await s.json('POST', '/api/import/preview', { csv: csvOf([KNOWN, ...fresh]) });
  assert.equal(status, 200);
  assert.deepEqual(yt.calls.map((c) => [c.endpoint, c.ids.length]), [['channels', 50], ['channels', 10]]);
  assert.equal(body.lookupUnits, 2);
  assert.deepEqual([body.listed, body.alreadyIn, body.notFound, body.channels.length, body.suggestedBy], [61, 1, 1, 59, 'keywords']);
  assert.ok(!body.channels.some((c) => c.id === KNOWN));
  assert.deepEqual(body.channels[0], {
    id: id(1),
    name: 'Channel 001',
    handle: '@ch001',
    avatar: `https://yt3.example/${id(1)}`,
    videoCount: 120,
    topics: ['woodworking'],
    backfillUnits: 9,
  });
});

test('import adds new channels with RSS videos, backfills one at a time, and a second import adds nothing', async (t) => {
  const yt = fakeApi();
  const s = await start(t, { api: yt.api });
  const csv = csvOf([KNOWN, id(1), id(2), id(3)]);
  const preview = (await s.json('POST', '/api/import/preview', { csv })).body;
  const picked = preview.channels.map((c) => ({ ...c, topics: ['board-games'] }));

  const first = await s.json('POST', '/api/import', { channels: picked });
  assert.deepEqual(first.body, { added: 3, skipped: 0, backfillsQueued: 3 });
  const listed = (await s.json('GET', '/api/channels')).body.channels;
  const imported = listed.filter((c) => c.id !== KNOWN);
  assert.deepEqual(imported.map((c) => [c.id, c.handle, c.topics, c.counts.long]), [id(1), id(2), id(3)].map((c) => [c, `@ch${c.slice(-3)}`, ['board-games'], 1]));
  assert.deepEqual(imported.map((c) => c.backfill), ['running', 'queued', 'queued']);

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(yt.maxRunning, 1, 'backfills never overlap');
  assert.deepEqual((await s.json('GET', '/api/channels')).body.channels.map((c) => c.backfill), ['idle', 'done', 'done', 'done']);

  const again = await s.json('POST', '/api/import/preview', { csv });
  assert.deepEqual([again.body.channels.length, again.body.alreadyIn], [0, 4]);
  const second = await s.json('POST', '/api/import', { channels: picked });
  assert.deepEqual(second.body, { added: 0, skipped: 3, backfillsQueued: 0 });
  assert.equal(s.db.listChannels().length, 4);
});

test('/api/meta tells which channels have a backfill running or queued', async (t) => {
  const s = await start(t, { api: fakeApi().api });
  await s.json('POST', '/api/import', { channels: [id(1), id(2)].map((c) => ({ id: c, name: c, topics: [] })) });
  const backfills = new Map((await s.json('GET', '/api/meta')).body.channels.map((c) => [c.id, c.backfill]));
  assert.deepEqual([KNOWN, id(1), id(2)].map((c) => backfills.get(c)), ['idle', 'running', 'queued']);
});

test('unsubscribing a queued channel takes it off the backfill queue', async (t) => {
  const yt = fakeApi();
  const s = await start(t, { api: yt.api });
  await s.json('POST', '/api/import', { channels: [id(1), id(2)].map((c) => ({ id: c, name: c, topics: [] })) });
  assert.equal((await s.json('PATCH', `/api/channels/${id(2)}`, { subscribed: false })).body.backfill, 'idle');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(yt.calls.some((c) => c.playlistId?.endsWith(id(1).slice(2))), 'the first channel was backfilled');
  assert.ok(!yt.calls.some((c) => c.playlistId?.endsWith(id(2).slice(2))), 'the cancelled one was not');
  assert.equal(s.db.listChannels().find((c) => c.id === id(2)).subscribed, false);
});

test('stopBackfills stops the running and the queued backfills unfinished, and the next app on the database finishes them', async (t) => {
  const yt = fakeApi();
  const s = await start(t, { api: yt.api });
  await s.json('POST', '/api/import', { channels: [id(1), id(2)].map((c) => ({ id: c, name: c, topics: [] })) });
  s.app.stopBackfills();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!yt.calls.some((c) => c.playlistId?.endsWith(id(2).slice(2))), 'the queued channel was not backfilled');
  assert.deepEqual([id(1), id(2)].map((c) => s.db.backfill(c).state), ['running', 'queued']);

  testApp({ db: s.db, api: fakeApi().api });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual([id(1), id(2)].map((c) => s.db.backfill(c).state), ['done', 'done']);
});

test('without an API key, preview uses the CSV titles and import stores RSS videos with no backfill', async (t) => {
  const s = await start(t);
  const { body } = await s.json('POST', '/api/import/preview', { csv: csvOf([id(7)]).replace('Channel 007', 'Weekend Woodworker') });
  assert.deepEqual(body.channels, [{ id: id(7), name: 'Weekend Woodworker', handle: null, avatar: null, videoCount: null, topics: ['woodworking'], backfillUnits: 0 }]);
  assert.equal(body.backfillAvailable, false);
  const done = await s.json('POST', '/api/import', { channels: body.channels });
  assert.deepEqual(done.body, { added: 1, skipped: 0, backfillsQueued: 0 });
  assert.equal((await s.json('GET', '/api/channels')).body.channels.find((c) => c.id === id(7)).counts.long, 1);
});

test('a bad CSV or an unknown topic is refused', async (t) => {
  const s = await start(t);
  assert.equal((await s.json('POST', '/api/import/preview', { csv: 'hello' })).status, 400);
  const bad = await s.json('POST', '/api/import', { channels: [{ id: id(1), name: 'x', topics: ['nope'] }] });
  assert.equal(bad.status, 400);
  assert.equal(s.db.listChannels().length, 1);
});

test('the Claude suggester sends topics with examples and keeps only known topics and new groups of three or more', async () => {
  let request;
  const answer = {
    channels: [
      { id: id(1), groups: ['woodworking', 'made-up'] },
      { id: id(2), groups: [] },
      { id: 'UCnotinthisbatch000000000', groups: ['woodworking'] },
    ],
    newGroups: [
      { name: 'Cooking', channelIds: [id(2), id(3), id(4)] },
      { name: 'Cars', channelIds: [id(5)] },
    ],
  };
  const fetchImpl = async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] });
  };
  const suggest = claudeSuggester('test-key', fetchImpl);
  const channels = [1, 2, 3, 4, 5].map((n) => ({ id: id(n), name: `C${n}`, description: 'x'.repeat(500) }));
  const result = await suggest({ channels, topics: [{ id: 'woodworking', name: 'Woodworking', examples: ['Shop Guy'] }] });
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'test-key');
  assert.equal(request.body.model, CLAUDE_MODEL);
  assert.equal(request.body.output_config.format.type, 'json_schema');
  const sent = JSON.parse(request.body.messages[0].content);
  assert.deepEqual(sent.groups, [{ id: 'woodworking', name: 'Woodworking', exampleChannels: ['Shop Guy'] }]);
  assert.equal(sent.channels[0].description.length, 300);
  assert.deepEqual([...result.groups], [[id(1), ['woodworking']], [id(2), []]]);
  assert.deepEqual(result.newGroups, [{ name: 'Cooking', channelIds: [id(2), id(3), id(4)] }]);
});

test('preview uses Claude when configured and falls back to keywords when it fails', async (t) => {
  const yt = fakeApi({ describe: () => 'Woodworking every week' });
  const claude = async ({ channels }) => ({ groups: new Map(channels.map((c) => [c.id, ['board-games']])), newGroups: [{ name: 'Lathes', channelIds: channels.map((c) => c.id) }] });
  const s = await start(t, { api: yt.api, suggestGroups: claude });
  const ok = (await s.json('POST', '/api/import/preview', { csv: csvOf([id(1)]) })).body;
  assert.deepEqual([ok.suggestedBy, ok.channels[0].topics, ok.newGroups], ['claude', ['board-games'], [{ name: 'Lathes', channelIds: [id(1)] }]]);

  const failing = await start(t, { api: yt.api, suggestGroups: async () => Promise.reject(new Error('HTTP 529')) });
  const fallback = (await failing.json('POST', '/api/import/preview', { csv: csvOf([id(1)]) })).body;
  assert.deepEqual([fallback.suggestedBy, fallback.suggestError, fallback.channels[0].topics], ['keywords', 'HTTP 529', ['woodworking']]);
});
