import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashOf, routeOf } from '../public/route.js';

const groups = [{ id: 'all' }, { id: 'topic-a' }, { id: 'favorites' }];
const channels = new Map([['UCknown', {}]]);
const route = (hash, saved = 'all') => routeOf(hash, groups, channels, saved);

test('a group, channel or search hash reads back to the same hash', () => {
  for (const hash of ['#/topic-a', '#/topic-a/channel/UCknown', '#/topic-a/search/a%20b', '#/all/search/caf%C3%A9%20%2F%23']) {
    assert.equal(hashOf(route(hash)), hash, hash);
  }
  assert.deepEqual(route('#/topic-a/channel/UCknown'), { group: groups[1], channelId: 'UCknown', q: null });
  assert.deepEqual(route('#/topic-a/search/a%20b'), { group: groups[1], channelId: null, q: 'a b' });
});

test('a search text is trimmed, and an empty or badly escaped one opens the group', () => {
  assert.equal(route('#/all/search/%20%20lathe%20').q, 'lathe');
  assert.deepEqual(route('#/topic-a/search/%20'), { group: groups[1], channelId: null, q: null });
  assert.deepEqual(route('#/topic-a/search/%E0%A4%A'), { group: groups[1], channelId: null, q: null });
  assert.deepEqual(route('#/topic-a/search'), { group: groups[1], channelId: null, q: null });
});

test('an unknown group falls back to the saved group, then to the first group', () => {
  assert.equal(route('#/gone-topic', 'favorites').group, groups[2]);
  assert.equal(route('#/gone-topic', 'also-gone').group, groups[0]);
  assert.equal(route('', 'topic-a').group, groups[1]);
  assert.equal(route('#/gone-topic/search/a%20b').group, groups[0]);
});

test('a channel route whose channel a meta refresh dropped resolves to its group, so the tab opens it again', () => {
  const hash = '#/topic-a/channel/UCgone';
  const before = routeOf(hash, groups, new Map([['UCgone', {}]]), 'all');
  assert.equal(before.channelId, 'UCgone');
  assert.equal(hashOf(before), hash, 'a route the meta still holds keeps its hash');
  const after = routeOf(hash, groups, new Map(), 'all');
  assert.deepEqual(after, { group: groups[1], channelId: null, q: null });
  assert.equal(hashOf(after), '#/topic-a');
});
