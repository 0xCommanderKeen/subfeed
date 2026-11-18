import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MATCH_COUNT_CAP, openDb } from '../src/db.mjs';
import { searchWorker } from '../src/search-worker.mjs';
import { feedVideo, startApp } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const QUERY = { channelIds: [A], shorts: 'include', limit: 5 };

const video = (n, title) => feedVideo({ id: `vid${String(n).padStart(8, '0')}`, channelId: A, title, published: new Date(Date.UTC(2025, 0, 1) + n * 60_000).toISOString() });

// More videos match "lathe" than the count goes to; one matches "gearbox".
function fileDb() {
  const file = join(mkdtempSync(join(tmpdir(), 'subfeed-search-')), 'subfeed.db');
  const db = openDb(file);
  db.subscribeChannel({ id: A, name: 'Workshop', handle: '@workshop' }, []);
  const videos = Array.from({ length: MATCH_COUNT_CAP + 5 }, (_, n) => video(n, `Lathe part ${n}`));
  videos.push(video(MATCH_COUNT_CAP + 5, 'Gearbox rebuild'));
  db.upsertVideos(videos);
  return { file, db };
}

// The tests only read it.
const { file, db } = fileDb();
after(() => db.close());

test('the search worker answers what db.searchPage answers, and caps the count of a word most videos match', async (t) => {
  const worker = searchWorker(file);
  t.after(() => worker.close());

  const common = await worker.search({ ...QUERY, q: 'lathe' });
  assert.deepEqual(common, db.searchPage({ ...QUERY, q: 'lathe' }));
  assert.equal(common.total, MATCH_COUNT_CAP);
  assert.equal(common.totalCapped, true);
  assert.equal(common.videos.length, 5);

  const rare = await worker.search({ ...QUERY, q: 'gearbox' });
  assert.deepEqual(rare.videos.map((v) => v.title), ['Gearbox rebuild']);
  assert.equal(rare.total, 1);
  assert.equal(rare.totalCapped, undefined);

  const next = await worker.search({ ...QUERY, q: 'lathe', before: common.videos.at(-1) });
  assert.equal(next.total, undefined, 'a later page carries no count');
  assert.equal(next.videos.length, 5);
  assert.ok(!next.videos.some((v) => common.videos.some((w) => w.id === v.id)));
});

test('a search whose request goes away while it waits for the worker is dropped, and the next one is answered', async (t) => {
  const worker = searchWorker(file);
  t.after(() => worker.close());

  const running = worker.search({ ...QUERY, q: 'lathe' });
  const gone = new AbortController();
  const waiting = worker.search({ ...QUERY, q: 'part' }, gone.signal);
  gone.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal((await running).total, MATCH_COUNT_CAP);
  await assert.rejects(worker.search({ ...QUERY, q: 'lathe' }, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal((await worker.search({ ...QUERY, q: 'gearbox' })).total, 1);
});

test('a capped search says so over the API and in the MCP search tool, and its cursor pages on', async (t) => {
  const worker = searchWorker(file);
  const { json, mcp } = await startApp(t, { db, search: worker.search });
  t.after(() => worker.close());
  const get = async (path) => (await json('GET', path)).body;

  const first = await get('/api/videos?q=lathe&limit=3');
  assert.equal(first.total, MATCH_COUNT_CAP);
  assert.equal(first.totalCapped, true);
  assert.equal(first.videos.length, 3);
  const second = await get(`/api/videos?q=lathe&limit=3&before=${first.nextCursor}`);
  assert.equal(second.videos.length, 3);
  assert.equal(second.total, undefined);

  const exact = await get('/api/videos?q=gearbox');
  assert.equal(exact.total, 1);
  assert.equal(exact.totalCapped, undefined);

  const text = await mcp('search', { query: 'lathe' });
  assert.match(text, new RegExp(`^More than ${MATCH_COUNT_CAP} in .* match "lathe":`));
  assert.match(text, /… and more\. Call again with offset: 30\.$/);
});
