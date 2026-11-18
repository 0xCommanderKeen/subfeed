import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VIDEO_ITEM, shortcutAction, stepIndex } from '../public/shortcuts.js';

const field = { closest: (selector) => (selector.includes('input') ? {} : null) };
const page = { closest: () => null };
const press = (key, extra = {}) => shortcutAction({ key, target: page, ...extra });

test('each video key maps to its action', () => {
  assert.deepEqual(['j', 'k', 'o', 'w', 's', '/', '?'].map((k) => press(k)), ['next', 'previous', 'open', 'later', 'star', 'search', 'help']);
});

test('keys left to the browser or the sidebar, and unknown keys, do nothing', () => {
  for (const key of ['Enter', '[', 'a', 'J', 'Escape']) assert.equal(press(key), null, key);
});

test('shortcuts are ignored while typing or with a modifier held', () => {
  assert.equal(press('j', { target: field }), null);
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(press('s', { [mod]: true }), null, mod);
});

test('stepping moves one card and stops at both ends', () => {
  assert.equal(stepIndex(5, 2, 1), 3);
  assert.equal(stepIndex(5, 2, -1), 1);
  assert.equal(stepIndex(5, 4, 1), 4);
  assert.equal(stepIndex(5, 0, -1), 0);
});

test('with no focused card, j starts at the first card and k at the last', () => {
  assert.equal(stepIndex(5, -1, 1), 0);
  assert.equal(stepIndex(5, -1, -1), 4);
  assert.equal(stepIndex(0, -1, 1), -1);
});

test('the focus ring fits inside the shelf track top padding', async () => {
  const css = await (await import('node:fs/promises')).readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  const ring = css.match(/\.card \.title:focus-visible::after \{[^}]*inset: -(\d+)px[^}]*box-shadow: 0 0 0 (\d+)px/);
  const track = css.match(/\n\.track \{[^}]*padding: (\d+)px/);
  assert.ok(ring && track, 'ring and track rules found');
  assert.ok(Number(ring[1]) + Number(ring[2]) <= Number(track[1]), 'ring is not clipped at the top of a shelf');
});

test('j and k reach every kind of video item the page renders, Watch Later rows included', async () => {
  const app = await (await import('node:fs/promises')).readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const rendered = [...app.matchAll(/className: `([\w-]+)[^`]*`, dataset: \{ id: v\.id \}/g)].map((m) => m[1]);
  const covered = VIDEO_ITEM.split(',').map((s) => s.trim().replace(/^\./, ''));
  assert.deepEqual(rendered.sort(), ['card', 'queue-row']);
  for (const name of rendered) assert.ok(covered.includes(name), name);
});
