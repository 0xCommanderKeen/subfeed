import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backfilling, inactiveChannels, lastUpload, lastUploadText, stopBackfillQuestion, tickedChannels } from '../public/activity.js';

const now = new Date('2026-11-16T12:00:00Z');
const channel = (name, latest, subscribed = true) => ({ id: name, name, subscribed, latest: { long: null, short: null, stream: null, ...latest } });

test('the last upload is the newest of long videos, Shorts and streams', () => {
  assert.equal(lastUpload(channel('a', { long: '2026-01-01T00:00:00Z', short: '2026-03-01T00:00:00Z', stream: '2025-12-01T00:00:00Z' })), '2026-03-01T00:00:00Z');
  assert.equal(lastUpload(channel('a', {})), null);
});

test('inactive channels are the subscribed ones silent for the period, longest silent first', () => {
  const channels = [
    channel('Recent', { long: '2026-11-01T00:00:00Z' }),
    channel('Mumbo', { long: '2026-04-01T00:00:00Z' }),
    channel('Teaching Tech', { long: '2025-02-01T00:00:00Z', short: '2025-06-01T00:00:00Z' }),
    channel('Short only', { short: '2026-10-01T00:00:00Z', long: '2024-01-01T00:00:00Z' }),
    channel('Empty', {}),
    channel('Gone', { long: '2020-01-01T00:00:00Z' }, false),
  ];
  assert.deepEqual(inactiveChannels(channels, 180, now).map((c) => c.name), ['Empty', 'Teaching Tech', 'Mumbo']);
  assert.deepEqual(inactiveChannels(channels, 365, now).map((c) => c.name), ['Empty', 'Teaching Tech']);
  assert.deepEqual(inactiveChannels(channels, 10, now).map((c) => c.name), ['Empty', 'Teaching Tech', 'Mumbo', 'Short only', 'Recent']);
});

test('the last upload reads as time ago', () => {
  const text = (long) => lastUploadText(channel('a', { long }), now);
  assert.equal(text('2026-11-16T08:00:00Z'), 'Last upload today');
  assert.equal(text('2026-11-15T08:00:00Z'), 'Last upload 1 day ago');
  assert.equal(text('2026-05-01T00:00:00Z'), 'Last upload 6 months ago');
  assert.equal(text('2023-01-01T00:00:00Z'), 'Last upload 3 years ago');
  assert.equal(lastUploadText(channel('a', {}), now), 'No uploads stored');
});

test('bulk actions take only the ticked channels the list still shows', () => {
  const channels = [
    channel('Mumbo', { long: '2026-04-01T00:00:00Z' }),
    channel('Teaching Tech', { long: '2024-02-01T00:00:00Z' }),
    channel('Coding Garden', { long: '2026-07-01T00:00:00Z' }),
    channel('Recent', { long: '2026-11-01T00:00:00Z' }),
  ];
  const inactive = (days, filter = '') => ({ view: 'inactive', filter, days });
  const selected = new Set(inactiveChannels(channels, 90, now).map((c) => c.id));
  const names = (options) => tickedChannels(channels, selected, options, now).map((c) => c.name);
  assert.deepEqual(names(inactive(90)), ['Teaching Tech', 'Mumbo', 'Coding Garden']);
  assert.deepEqual(names(inactive(730)), ['Teaching Tech']);
  assert.deepEqual(names(inactive(90, 'mum')), ['Mumbo']);
  assert.deepEqual(names({ view: 'all', filter: 'garden', days: 90 }), ['Coding Garden']);
  assert.deepEqual(names({ view: 'all', filter: '', days: 90 }), ['Mumbo', 'Teaching Tech', 'Coding Garden']);
});

test('unsubscribing asks first only for channels whose backfill runs or waits, and names them', () => {
  const states = ['running', 'queued', 'done', 'failed', null];
  const channels = states.map((backfill) => ({ name: String(backfill), backfill }));
  assert.deepEqual(channels.filter(backfilling).map((c) => c.name), ['running', 'queued']);
  assert.equal(stopBackfillQuestion([{ name: 'Mumbo' }, { name: 'Teaching Tech' }]),
    'Unsubscribing stops the backfill of Mumbo, Teaching Tech, and Undo does not start it again. Unsubscribe anyway?');
});
