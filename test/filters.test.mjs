import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FILTERS, filterParams } from '../public/filters.js';
import { buildGroups, groupSize } from '../public/groups.js';
import { feedVideo, startApp } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';

test('filterParams sends each switch as its API value, and a switch left out as off', () => {
  assert.deepEqual(filterParams({}), { shorts: 'include', streams: 'include', watched: 'include', muted: 'hide' });
  assert.deepEqual(filterParams({ hideShorts: true, hideStreams: true, hideWatched: true, showMuted: true }), { shorts: 'exclude', streams: 'exclude', watched: 'exclude', muted: 'show' });
  assert.deepEqual(filterParams({ hideWatched: true }), { shorts: 'include', streams: 'include', watched: 'exclude', muted: 'hide' });
});

test('every filter in the table changes the listed videos and the sidebar count alike', async (t) => {
  const { db, json } = await startApp(t);
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.upsertVideos([
    feedVideo({ id: 'long0000001', channelId: A, title: 'A long video', kind: 'video' }),
    feedVideo({ id: 'short000001', channelId: A, title: 'A Short', kind: 'short', isShort: true }),
    feedVideo({ id: 'livenow0001', channelId: A, title: 'A live stream', kind: 'live' }),
    feedVideo({ id: 'watched0001', channelId: A, title: 'A watched video', kind: 'video' }),
    feedVideo({ id: 'muted000001', channelId: A, title: 'A muted video', kind: 'video' }),
  ]);
  db.markWatched(['watched0001']);
  const get = async (path) => (await json('GET', path)).body;
  await json('POST', '/api/rules', { kind: 'mute', pattern: 'muted' });
  const meta = await get('/api/meta');
  const everything = buildGroups(meta).find((g) => g.id === 'all');
  const listed = async (filters) => (await get(`/api/videos?${new URLSearchParams({ ...filterParams(filters), length: 'any', limit: 50 })}`)).videos.map((v) => v.id).sort();
  const off = await listed({});
  assert.deepEqual(off, ['livenow0001', 'long0000001', 'short000001', 'watched0001']);
  const changed = { hideShorts: ['short000001'], hideStreams: ['livenow0001'], hideWatched: ['watched0001'], showMuted: ['muted000001'] };
  assert.deepEqual(FILTERS.map((f) => f.key), Object.keys(changed));
  for (const { key } of FILTERS) {
    const on = await listed({ [key]: true });
    const diff = [...on.filter((id) => !off.includes(id)), ...off.filter((id) => !on.includes(id))];
    assert.deepEqual(diff, changed[key], key);
    assert.equal(groupSize(everything, meta, { [key]: true }), on.length, `${key} counts what it lists`);
  }
});
