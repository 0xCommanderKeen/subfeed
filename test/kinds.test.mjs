import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bucketOf } from '../public/groups.js';
import { KINDS, kindOf, kindSql } from '../public/kinds.js';
import { CHANNEL_ID, VIDEO_ID, fold, formatAge, formatDuration, plural, wordsOf } from '../public/vocab.js';

const FLAGS = ['needsDetails', 'isStream', 'announceable', 'watchable'];

test('each kind flag means the same in SQL as in JS, NULL included', () => {
  const db = new DatabaseSync(':memory:');
  for (const kind of [...Object.keys(KINDS), null]) {
    for (const flag of FLAGS) {
      const { hit } = db.prepare(`SELECT ${kindSql(flag)} AS hit FROM (SELECT ? AS kind) v`).get(kind);
      assert.equal(Boolean(hit), kindOf(kind)[flag], `${flag} for ${kind}`);
    }
  }
});

test('the kind table keeps the rules the app relies on', () => {
  const kindsWith = (flag) => [...Object.keys(KINDS), null].filter((k) => kindOf(k)[flag]);
  assert.deepEqual(kindsWith('needsDetails'), ['upcoming', 'live', null]);
  assert.deepEqual(kindsWith('isStream'), ['upcoming', 'live']);
  assert.deepEqual(kindsWith('announceable'), ['video', 'live', 'stream_replay', null]);
  assert.deepEqual(kindsWith('watchable').includes('upcoming'), false);
  assert.equal(bucketOf({ isShort: false, kind: 'live' }), 'stream');
  assert.equal(bucketOf({ isShort: true, kind: 'upcoming' }), 'short');
  assert.equal(bucketOf({ isShort: false, kind: 'stream_replay' }), 'long');
});

test('shared vocabulary', () => {
  assert.ok(VIDEO_ID.test('abcdefghi_-'));
  assert.ok(!VIDEO_ID.test('abcdefghij'));
  assert.ok(CHANNEL_ID.test('UC_x5XG1OV2P6uZZ5FSM9Ttw'));
  assert.ok(!CHANNEL_ID.test('UC_x5XG1OV2P6uZZ5FSM9Tt'));
  assert.equal(fold(' Ćafé '), 'cafe');
  assert.deepEqual(wordsOf('Voron 2.4 — "build"!'), ['Voron', '2', '4', 'build']);
  const now = Date.parse('2026-11-17T12:00:00Z');
  assert.equal(formatAge('2026-11-17T11:59:30Z', now), '30s');
  assert.equal(formatAge('2026-11-17T12:00:30Z', now), '0s');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(plural(1, 'match', 'matches'), '1 match');
  assert.equal(plural(1200, 'video'), '1,200 videos');
});
