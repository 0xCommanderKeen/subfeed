import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { feedVideo } from './helpers.mjs';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';

function queueDb() {
  const db = openDb(':memory:');
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.subscribeChannel({ id: B, name: 'B' }, []);
  db.upsertVideos([feedVideo({ id: 'aaaaaaaaaa1', channelId: A }), feedVideo({ id: 'aaaaaaaaaa2', channelId: A }), feedVideo({ id: 'aaaaaaaaaa3', channelId: A, isShort: true }), feedVideo({ id: 'bbbbbbbbbb1', channelId: B }), feedVideo({ id: 'bbbbbbbbbb2', channelId: B })]);
  return db;
}

const order = (db, shorts) => db.listQueue({ shorts }).map((v) => v.id);

test('the queue keeps the order videos were added in, and adding a queued video again changes nothing', () => {
  const db = queueDb();
  for (const id of ['bbbbbbbbbb1', 'aaaaaaaaaa1', 'aaaaaaaaaa2', 'bbbbbbbbbb1']) db.enqueue(id);
  assert.deepEqual(order(db), ['bbbbbbbbbb1', 'aaaaaaaaaa1', 'aaaaaaaaaa2']);
  assert.ok(db.listQueue().every((v) => v.queued));
});

test('before moves a video in front of another, and null or an unqueued id moves it to the end', () => {
  const db = queueDb();
  for (const id of ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'bbbbbbbbbb1', 'bbbbbbbbbb2']) db.enqueue(id);
  db.moveInQueue('bbbbbbbbbb2', 'aaaaaaaaaa1');
  assert.deepEqual(order(db), ['bbbbbbbbbb2', 'aaaaaaaaaa1', 'aaaaaaaaaa2', 'bbbbbbbbbb1']);
  db.moveInQueue('bbbbbbbbbb2', null);
  assert.deepEqual(order(db), ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'bbbbbbbbbb1', 'bbbbbbbbbb2']);
  db.moveInQueue('aaaaaaaaaa1', 'aaaaaaaaaa3');
  assert.deepEqual(order(db), ['aaaaaaaaaa2', 'bbbbbbbbbb1', 'bbbbbbbbbb2', 'aaaaaaaaaa1']);
});

test('undo puts a removed video back in front of the one that followed it', () => {
  const db = queueDb();
  for (const id of ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'bbbbbbbbbb1']) db.enqueue(id);
  db.unqueueVideo('aaaaaaaaaa2');
  assert.deepEqual(order(db), ['aaaaaaaaaa1', 'bbbbbbbbbb1']);
  db.moveInQueue('aaaaaaaaaa2', 'bbbbbbbbbb1');
  assert.deepEqual(order(db), ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'bbbbbbbbbb1']);
});

test('a move among visible videos lands right while Shorts are hidden', () => {
  const db = queueDb();
  for (const id of ['aaaaaaaaaa1', 'aaaaaaaaaa3', 'aaaaaaaaaa2']) db.enqueue(id);
  assert.deepEqual(order(db, 'exclude'), ['aaaaaaaaaa1', 'aaaaaaaaaa2']);
  db.moveInQueue('aaaaaaaaaa2', 'aaaaaaaaaa1');
  assert.deepEqual(order(db), ['aaaaaaaaaa2', 'aaaaaaaaaa1', 'aaaaaaaaaa3']);
});

test('queued counts, the queued filter, unsubscribing and deleting a channel', () => {
  const db = queueDb();
  for (const id of ['aaaaaaaaaa1', 'aaaaaaaaaa3', 'bbbbbbbbbb1']) db.enqueue(id);
  assert.deepEqual(db.channelStats().get(A).queued, { long: 1, short: 1, stream: 0 });
  const listed = db.listVideos({ channelIds: [A, B], shorts: 'include', favoritesOnly: false, queuedOnly: true, limit: 10 }).videos;
  assert.deepEqual(listed.map((v) => v.id).sort(), ['aaaaaaaaaa1', 'aaaaaaaaaa3', 'bbbbbbbbbb1']);

  db.updateChannel(B, { subscribed: false });
  assert.deepEqual(order(db), ['aaaaaaaaaa1', 'aaaaaaaaaa3'], 'an unsubscribed channel leaves the queue view');
  db.updateChannel(B, { subscribed: true });
  assert.deepEqual(order(db), ['aaaaaaaaaa1', 'aaaaaaaaaa3', 'bbbbbbbbbb1'], 'and comes back on resubscribe');

  db.deleteChannel(A);
  db.subscribeChannel({ id: A, name: 'A' }, []);
  db.upsertVideos([feedVideo({ id: 'aaaaaaaaaa1', channelId: A })]);
  assert.deepEqual(order(db), ['bbbbbbbbbb1'], 'deleting a channel removes its queued videos for good');
});
