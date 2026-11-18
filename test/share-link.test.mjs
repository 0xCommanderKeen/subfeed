import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseShared } from '../public/share-link.js';

const ID = 'dQw4w9WgXcQ';
const video = { kind: 'video', id: ID, isShort: false };

test('parseShared finds a video in every link form the YouTube app and browsers share', () => {
  const cases = [
    [[`https://youtu.be/${ID}?si=AbCdEf123`], video],
    [[`https://youtu.be/${ID}`], video],
    [[`https://www.youtu.be/${ID}`], video],
    [[`https://www.youtube.com/watch?v=${ID}&t=42s`], video],
    [[`https://m.youtube.com/watch?feature=share&v=${ID}`], video],
    [[`https://music.youtube.com/watch?v=${ID}`], video],
    [[`https://youtube.com/live/${ID}?si=x`], video],
    [[`https://youtube.com/shorts/${ID}?si=x`], { ...video, isShort: true }],
    [[null, `Never Gonna Give You Up https://youtu.be/${ID}?si=x`, 'Rick Astley'], video],
    [['', `https://youtu.be/${ID}`], video],
  ];
  for (const [parts, expected] of cases) assert.deepEqual(parseShared(...parts), expected, parts.join(' | '));
});

test('parseShared passes a channel link or @handle on for the Manage add form', () => {
  const channel = (input) => ({ kind: 'channel', input });
  assert.deepEqual(parseShared('https://youtube.com/@CNCKitchen?si=AbC'), channel('https://www.youtube.com/@CNCKitchen'));
  assert.deepEqual(parseShared('https://m.youtube.com/@CNCKitchen/videos'), channel('https://www.youtube.com/@CNCKitchen/videos'));
  assert.deepEqual(parseShared('Check out CNC Kitchen https://www.youtube.com/channel/UCiczXOhGpvoQGhOL16EZiTg'), channel('https://www.youtube.com/channel/UCiczXOhGpvoQGhOL16EZiTg'));
  assert.deepEqual(parseShared('  @CNCKitchen '), channel('@CNCKitchen'));
});

test('parseShared rejects what is not a YouTube video or channel', () => {
  for (const parts of [[], [null, ''], ['hello world'], ['https://example.com/watch?v=dQw4w9WgXcQ'], ['https://youtu.be/short'],
    ['https://www.youtube.com/watch?v=toolong12345'], ['https://www.youtube.com/playlist?list=PL123'], ['https://www.youtube.com/'], ['@ab']]) {
    assert.equal(parseShared(...parts), null, parts.join(' | '));
  }
});
