import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { buildGroups, groupSize, ruleHides } from '../public/groups.js';
import { titleHas } from '../public/vocab.js';
import { feedVideo, startApp } from './helpers.mjs';

const GMG = 'UCgggggggggggggggggggggg';
const TM = 'UCtttttttttttttttttttttt';

let n = 0;
const video = (channelId, title) => {
  n++;
  return feedVideo({ id: `vid${String(n).padStart(8, '0')}`, channelId, title, published: new Date(Date.UTC(2026, 10, 1, n)).toISOString() });
};

// Guerrilla Miniature Games is in Painting and Games, Tabletop Minions in Painting only.
// The rules: mute "Every Other Sunday Show" in Painting, mute "live" everywhere, and route GMG into Painting for "Paint Table".
async function start(t) {
  const s = await startApp(t);
  const { db, json } = s;
  db.ensureTopic('paint', 'Miniature Painting');
  db.ensureTopic('games', 'Games');
  db.subscribeChannel({ id: GMG, name: 'Guerrilla Miniature Games' }, ['paint', 'games']);
  db.subscribeChannel({ id: TM, name: 'Tabletop Minions' }, ['paint']);
  const v = {
    paintTable: video(GMG, 'Paint Table Saturday #12'),
    review: video(GMG, 'Review: the new starter box'),
    live: video(GMG, 'Battle report LIVE!'),
    gmgSunday: video(GMG, 'Every Other Sunday Show, episode 3'),
    painting: video(TM, 'Painting Space Marines'),
    tmSunday: video(TM, 'every other sunday show 12'),
    news: video(TM, 'Game news weekly'),
    delivery: video(TM, 'Delivery day unboxing'),
  };
  db.upsertVideos(Object.values(v));
  const rules = [
    { kind: 'mute', pattern: 'Every Other Sunday Show', topic: 'paint' },
    { kind: 'mute', pattern: 'live' },
    { kind: 'route', pattern: 'Paint Table', channel: GMG, topic: 'paint' },
  ];
  for (const rule of rules) assert.equal((await json('POST', '/api/rules', rule)).status, 200, rule.pattern);
  return { ...s, v };
}

const titles = (videos) => videos.map((x) => x.title).sort();
const titlesOf = (v, keys) => keys.map((k) => v[k].title).sort();
const EVERYWHERE = ['paintTable', 'review', 'gmgSunday', 'painting', 'tmSunday', 'news', 'delivery'];
const IN_PAINT = ['paintTable', 'painting', 'news', 'delivery'];
const IN_GAMES = ['paintTable', 'review', 'gmgSunday'];

test('a pattern matches whole words in a row, ignoring case, accents and punctuation', () => {
  assert.equal(titleHas('Battle report LIVE!', 'live'), true);
  assert.equal(titleHas('Delivery day', 'live'), false);
  assert.equal(titleHas('PAINT-TABLE Saturday', 'paint table'), true);
  assert.equal(titleHas('Table paint', 'paint table'), false);
  assert.equal(titleHas('Café racers', 'cafe'), true);
  assert.equal(titleHas('anything', '!!!'), false);
});

test('a mute in one group hides the title there only; a mute without a group hides it everywhere; a route keeps a channel to its pattern', async (t) => {
  const s = await start(t);
  const list = async (query) => (await s.json('GET', `/api/videos?${query}`)).body.videos;
  assert.deepEqual(titles(await list('')), titlesOf(s.v, EVERYWHERE), 'Everything: only the mute without a group applies');
  assert.deepEqual(titles(await list('topic=paint')), titlesOf(s.v, IN_PAINT), 'Painting: its mute and the route apply');
  assert.deepEqual(titles(await list('topic=games')), titlesOf(s.v, IN_GAMES), 'Games: the Painting rules do not apply');
  assert.deepEqual(titles(await list(`channel=${GMG}`)), titlesOf(s.v, ['paintTable', 'review', 'gmgSunday']));
  assert.deepEqual(titles(await list(`channel=${GMG}&topic=paint`)), titlesOf(s.v, ['paintTable']), 'a channel opened in a group follows its route');

  const pages = [];
  for (let cursor = null; ;) {
    const page = (await s.json('GET', `/api/videos?topic=paint&limit=1${cursor ? `&before=${cursor}` : ''}`)).body;
    pages.push(...page.videos);
    if (!(cursor = page.nextCursor)) break;
  }
  assert.deepEqual(titles(pages), titlesOf(s.v, IN_PAINT), 'pages of one video add up to the same list');

  const shelves = (await s.json('GET', '/api/shelves?topic=paint')).body.shelves;
  assert.deepEqual(titles(shelves.flatMap((x) => x.videos)), titlesOf(s.v, IN_PAINT), 'shelves follow the same rules');

  const search = async (query) => (await s.json('GET', `/api/videos?q=sunday&${query}`)).body;
  assert.deepEqual([(await search('topic=paint')).total, (await search('topic=games')).total, (await search('')).total], [0, 1, 2], 'search counts follow the rules');
});

test('the counts in /api/meta follow the rules per group, and Show muted reveals and counts every video', async (t) => {
  const s = await start(t);
  const meta = (await s.json('GET', '/api/meta')).body;
  const groups = Object.fromEntries(buildGroups(meta).map((g) => [g.id, g]));
  const size = (id, showMuted = false) => groupSize(groups[id], meta, { showMuted });
  assert.deepEqual([size('all'), size('topic:paint'), size('topic:games')], [EVERYWHERE.length, IN_PAINT.length, IN_GAMES.length]);
  assert.deepEqual([size('all', true), size('topic:paint', true)], [8, 8]);
  assert.equal(meta.totalVideos, 8, 'muted videos still count as stored');

  const shown = (await s.json('GET', '/api/videos?topic=paint&muted=show')).body.videos;
  assert.deepEqual(titles(shown.filter((x) => x.muted)), titlesOf(s.v, ['review', 'live', 'gmgSunday', 'tmSunday']));
  assert.deepEqual(titles(shown.filter((x) => !x.muted)), titlesOf(s.v, IN_PAINT));
  assert.equal((await s.json('GET', '/api/videos?muted=maybe')).status, 400);
});

test('Hot follows the same rules, and Show muted marks what they hide', async (t) => {
  const s = await start(t);
  s.db.applyStats(Object.values(s.v).map((x) => ({ id: x.id, views: 1000 })));
  const hot = (muted) => s.db.listHot({
    channelIds: [GMG, TM], shorts: 'include', favoritesOnly: false, topic: 'paint', muted,
    since: '2026-10-01T00:00:00.000Z', now: '2026-12-01T00:00:00.000Z', offset: 0, limit: 50,
  }).videos;
  assert.deepEqual(titles(hot('hide')), titlesOf(s.v, IN_PAINT));
  const shown = hot('show');
  assert.deepEqual(titles(shown.filter((x) => x.muted)), titlesOf(s.v, ['review', 'live', 'gmgSunday', 'tmSunday']));
  assert.deepEqual(titles(shown.filter((x) => !x.muted)), titlesOf(s.v, IN_PAINT));
});

test('the page decides which videos the rules hide as the server does', async (t) => {
  const s = await start(t);
  const { rules } = (await s.json('GET', '/api/meta')).body;
  for (const [topic, listed] of [[null, 8], ['paint', 8], ['games', 4]]) {
    const { videos } = (await s.json('GET', `/api/videos?muted=show${topic ? `&topic=${topic}` : ''}`)).body;
    assert.equal(videos.length, listed);
    for (const v of videos) assert.equal(ruleHides(rules, v, topic), v.muted === true, `${v.title} in ${topic}`);
  }
});

test('starred videos and Watch Later ignore the rules', async (t) => {
  const s = await start(t);
  s.db.setFavorite(s.v.live.id, true);
  s.db.enqueue(s.v.live.id);
  for (const query of ['favorites=1', 'queued=1']) assert.deepEqual(titles((await s.json('GET', `/api/videos?${query}`)).body.videos), [s.v.live.title], query);
  const meta = (await s.json('GET', '/api/meta')).body;
  const groups = Object.fromEntries(buildGroups(meta).map((g) => [g.id, g]));
  assert.deepEqual([groupSize(groups.favorites, meta, {}), groupSize(groups['watch-later'], meta, {})], [1, 1]);
});

test('a channel mute hides the title in that channel only, and deleting a rule brings its videos back', async (t) => {
  const s = await start(t);
  const rule = (await s.json('POST', '/api/rules', { kind: 'mute', pattern: 'review', channel: TM })).body;
  assert.deepEqual(rule, { id: rule.id, kind: 'mute', pattern: 'review', channelId: TM, topicId: null });
  assert.ok(titles((await s.json('GET', '/api/videos')).body.videos).includes(s.v.review.title), 'a rule for another channel leaves GMG alone');
  const [route] = (await s.json('GET', '/api/rules')).body.rules.filter((r) => r.kind === 'route');
  assert.equal((await s.json('DELETE', `/api/rules/${route.id}`)).status, 204);
  assert.equal((await s.json('DELETE', `/api/rules/${route.id}`)).status, 404);
  assert.deepEqual(titles((await s.json('GET', '/api/videos?topic=paint')).body.videos), titlesOf(s.v, ['paintTable', 'review', 'painting', 'news', 'delivery']));
  const meta = (await s.json('GET', '/api/meta')).body;
  const paint = buildGroups(meta).find((g) => g.id === 'topic:paint');
  assert.equal(groupSize(paint, meta, {}), 5, 'the counts follow the deleted rule at once');
});

test('rules are checked when added and leave with their channel or topic', async (t) => {
  const s = await start(t);
  const bad = [
    [{ kind: 'route', pattern: 'x', channel: GMG }, 'a route rule needs a channel and a topic'],
    [{ kind: 'hide', pattern: 'x' }, 'kind must be mute or route'],
    [{ kind: 'mute', pattern: ' ?! ' }, 'pattern must hold a word and be at most 100 characters'],
    [{ kind: 'mute', pattern: 'x', topic: 'nope' }, 'topic must be an existing topic id or null'],
    [{ kind: 'mute', pattern: 'x', channel: 'UCnope' }, 'channel must be an existing channel id or null'],
  ];
  for (const [body, error] of bad) assert.deepEqual(await s.json('POST', '/api/rules', body), { status: 400, body: { error } });
  s.db.deleteTopic('paint');
  assert.deepEqual(s.db.listRules().map((r) => r.pattern), ['live']);
  s.db.addRule({ kind: 'mute', pattern: 'news', channelId: TM });
  s.db.deleteChannel(TM);
  assert.deepEqual(s.db.listRules().map((r) => r.pattern), ['live']);
});

test('rules match titles stored before the folded words were, and follow a title that changes', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-rules-')), 'old.db');
  const first = openDb(file);
  first.subscribeChannel({ id: TM, name: 'Tabletop Minions' }, []);
  const live = video(TM, 'Battle report LIVE!');
  const renamed = video(TM, 'Battle report');
  first.upsertVideos([live, renamed]);
  first.addRule({ kind: 'mute', pattern: 'live' });
  first.close();
  const old = new DatabaseSync(file);
  old.exec('UPDATE videos SET title_words = NULL; ALTER TABLE rules DROP COLUMN words; DROP TABLE meta; PRAGMA user_version = 0');
  old.close();
  const db = openDb(file);
  const listed = () => titles(db.listVideos({ channelIds: [TM], shorts: 'include', limit: 10 }).videos);
  assert.deepEqual(listed(), ['Battle report']);
  db.upsertVideos([{ ...renamed, title: 'Battle report (live)' }, { ...live, title: 'Battle report again' }]);
  assert.deepEqual(listed(), ['Battle report again']);
  db.close();
});
