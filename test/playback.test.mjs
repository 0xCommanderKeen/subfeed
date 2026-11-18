import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorText, mostlyPlayed, playsHere, positionToSave, stepFrom, wantsTab, youtubeUrl } from '../public/playback.js';

const video = (id, kind = 'video', isShort = false) => ({
  id, kind, isShort, url: isShort ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
});

test('upcoming premieres and streams open on YouTube; everything else plays in the page', () => {
  assert.equal(playsHere(video('a', 'upcoming')), false);
  for (const kind of ['video', 'short', 'live', 'stream_replay', null]) assert.equal(playsHere(video('a', kind)), true, kind);
});

test('middle-click and modifier clicks still open a tab', () => {
  const click = (props) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, ...props });
  assert.equal(wantsTab(click({})), false);
  assert.equal(wantsTab(click({ button: 1 })), true);
  assert.equal(wantsTab(click({ metaKey: true })), true);
  assert.equal(wantsTab(click({ ctrlKey: true })), true);
  assert.equal(wantsTab(click({ shiftKey: true })), true);
});

test('a video counts as watched from 90% played, and a live stream only when it ends', () => {
  assert.equal(mostlyPlayed(video('a'), 539, 600), false);
  assert.equal(mostlyPlayed(video('a'), 540, 600), true);
  assert.equal(mostlyPlayed(video('a'), 0, 0), false);
  assert.equal(mostlyPlayed(video('a', 'live'), 600, 600), false);
});

test('videos whose owner forbids embedding say so; other errors do not blame the owner', () => {
  for (const code of [101, 150]) assert.match(errorText(code), /does not allow/);
  assert.doesNotMatch(errorText(100), /does not allow/);
});

test('the YouTube link resumes where the player stopped, except for Shorts and near the start', () => {
  assert.equal(youtubeUrl(video('abc'), 125.7), 'https://www.youtube.com/watch?v=abc&t=125s');
  assert.equal(youtubeUrl(video('abc'), 2), 'https://www.youtube.com/watch?v=abc');
  assert.equal(youtubeUrl(video('abc', 'short', true), 125), 'https://www.youtube.com/shorts/abc');
});

test('Next and Previous skip upcoming videos and stop at the ends of the queue', () => {
  const queue = [video('a'), video('b', 'upcoming'), video('c'), video('d', 'upcoming')];
  assert.equal(stepFrom(queue, 0, 1), 2);
  assert.equal(stepFrom(queue, 2, -1), 0);
  assert.equal(stepFrom(queue, 2, 1), -1);
  assert.equal(stepFrom(queue, 0, -1), -1);
});

test('a position is saved in whole seconds, and forgotten for Shorts, live streams, the first 5 seconds and from the watched point', () => {
  assert.equal(positionToSave(video('a'), 125.7, 600), 125);
  assert.equal(positionToSave(video('a'), 539.9, 600), 539);
  assert.equal(positionToSave(video('a'), 125, 0), 125, 'a length the player does not know yet keeps the place');
  assert.equal(positionToSave(video('a', 'stream_replay'), 3600, 7200), 3600);
  assert.equal(positionToSave(video('a'), 5, 600), 5);
  assert.equal(positionToSave(video('a'), 4.9, 600), null);
  assert.equal(positionToSave(video('a', 'short', true), 30, 60), null);
  assert.equal(positionToSave(video('a', 'live'), 125, 0), null);
  assert.equal(positionToSave(video('a'), 540, 600), null);
  assert.equal(positionToSave(video('a'), 600, 600), null);
});
