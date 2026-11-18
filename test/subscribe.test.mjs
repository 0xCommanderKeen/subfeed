import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { subscribeChannel, LookupError } from '../src/subscribe.mjs';
import { feedVideo } from './helpers.mjs';

const ID = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const video = (n) => feedVideo({ id: `video${n}`.padStart(11, 'x'), channelId: ID, title: `Video ${n}`, published: new Date(Date.UTC(2026, 10, 15, 12, n)).toISOString() });

function fakeApi(body) {
  const calls = [];
  const api = async (endpoint, params) => (calls.push({ endpoint, params }), body);
  return { calls, api };
}

const feeds = (videos, error = null) => async () => ({ videos, error });

test('a new channel is looked up once, linked to its topics, and its feeds are stored through the refresh', async () => {
  const db = openDb(':memory:');
  db.ensureTopic('robotics', 'Robots');
  db.ensureTopic('3d-printing', '3D Printing');
  const { calls, api } = fakeApi({ items: [{ id: ID, snippet: { title: 'James Bruton', thumbnails: { medium: { url: 'https://yt3.ggpht.example/avatar=s240' } } } }] });
  const statuses = [];
  const result = await subscribeChannel(db, { kind: 'handle', handle: '@jamesbruton' }, ['robotics', '3d-printing'], {
    api,
    fetchFeeds: feeds([video(1), video(2)]),
    onChannel: (id, error) => statuses.push([id, error]),
  });
  assert.deepEqual(result, { created: true, channel: { id: ID, name: 'James Bruton', handle: '@jamesbruton', avatar: 'https://yt3.ggpht.example/avatar=s240' } });
  assert.equal(calls.length, 1);
  assert.deepEqual(statuses, [[ID, null]]);
  const [channel] = db.listChannels();
  assert.deepEqual(channel.topics, ['robotics', '3d-printing']);
  assert.equal(channel.avatar, 'https://yt3.ggpht.example/avatar=s240');
  assert.equal(db.channelStats().get(ID).counts.long, 2);
});

test('a known channel, matched by handle in any case, is resubscribed with merged topics and no lookup', async () => {
  const db = openDb(':memory:');
  db.ensureTopic('robotics', 'Robotics');
  db.ensureTopic('maker', 'Maker');
  db.subscribeChannel({ id: ID, name: 'James Bruton', handle: '@JamesBruton' }, ['robotics']);
  db.updateChannel(ID, { subscribed: false });
  const { calls, api } = fakeApi({ items: [] });
  const result = await subscribeChannel(db, { kind: 'handle', handle: '@jamesbruton' }, ['maker'], { api, fetchFeeds: feeds([video(1)]) });
  assert.equal(result.created, false);
  assert.equal(calls.length, 0);
  const [channel] = db.listChannels();
  assert.equal(channel.subscribed, true);
  assert.deepEqual(channel.topics, ['robotics', 'maker']);
});

test('an unknown channel returns null and adds nothing', async () => {
  const db = openDb(':memory:');
  const { api } = fakeApi({ items: [] });
  assert.equal(await subscribeChannel(db, { kind: 'id', id: ID }, [], { api, fetchFeeds: feeds([]) }), null);
  assert.deepEqual(db.listChannels(), []);
});

test('a failed lookup rejects with LookupError and adds nothing', async () => {
  const db = openDb(':memory:');
  const api = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(subscribeChannel(db, { kind: 'id', id: ID }, [], { api, fetchFeeds: feeds([]) }), (err) => err instanceof LookupError && err.message === 'fetch failed');
  assert.deepEqual(db.listChannels(), []);
});

test('a failed feed is reported to onChannel and still adds the channel', async () => {
  const db = openDb(':memory:');
  const { api } = fakeApi({ items: [{ id: ID, snippet: { title: 'A' } }] });
  const statuses = [];
  const result = await subscribeChannel(db, { kind: 'id', id: ID }, [], { api, fetchFeeds: feeds([], 'HTTP 500'), onChannel: (id, error) => statuses.push(error) });
  assert.equal(result.created, true);
  assert.deepEqual(statuses, ['HTTP 500']);
});

test('a lookup without fetchPage fails instead of loading the page with the global fetch', async (t) => {
  const globalFetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  const db = openDb(':memory:');
  await assert.rejects(subscribeChannel(db, { kind: 'id', id: ID }, [], { fetchFeeds: feeds([]) }), LookupError);
  assert.equal(globalFetch.mock.callCount(), 0);
});
