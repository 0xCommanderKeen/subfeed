import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_PATH, openDb } from './db.mjs';
import { CHANNEL_ID } from '../public/vocab.js';

export const CHANNELS_PATH = join(import.meta.dirname, '..', 'channels.json');

export function parseChannelsFile(text) {
  const data = JSON.parse(text);
  const fail = (msg) => {
    throw new Error(`channels.json: ${msg}`);
  };
  if (!data || typeof data.topics !== 'object' || !Array.isArray(data.channels)) fail('expected { "topics": {...}, "channels": [...] }');
  const hidden = data.hiddenTopics ?? [];
  if (!Array.isArray(hidden)) fail('hiddenTopics needs to be an array of topic ids');
  const unknownHidden = hidden.find((id) => !Object.hasOwn(data.topics, id));
  if (unknownHidden !== undefined) fail(`hiddenTopics lists unknown topic ${unknownHidden}`);
  const topics = Object.entries(data.topics).map(([id, name]) => {
    if (typeof name !== 'string') fail(`topic ${id} needs a string name`);
    return { id, name, hidden: hidden.includes(id) };
  });
  const topicIds = new Set(topics.map((t) => t.id));
  const seen = new Set();
  const channels = data.channels.map((c) => {
    if (!CHANNEL_ID.test(c?.id)) fail(`invalid channel id ${JSON.stringify(c?.id)}`);
    if (seen.has(c.id)) fail(`channel ${c.id} is listed twice`);
    seen.add(c.id);
    if (!Array.isArray(c.topics)) fail(`channel ${c.id} needs a topics array`);
    const unknown = c.topics.find((t) => !topicIds.has(t));
    if (unknown) fail(`channel ${c.id} uses unknown topic ${unknown}`);
    return { id: c.id, name: String(c.name ?? c.id), handle: c.handle ?? null, topics: c.topics, subscribed: c.subscribed !== false, favorite: c.favorite === true };
  });
  return { topics, channels };
}

// One channel per line, so adding or editing a channel shows up as a one-line diff.
export function formatChannelsFile({ topics, channels }) {
  const value = (v) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
  const object = (o) => `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${value(v)}`).join(', ')} }`;
  const line = (c) =>
    object({
      id: c.id,
      name: c.name,
      ...(c.handle && { handle: c.handle }),
      topics: c.topics,
      ...(!c.subscribed && { subscribed: false }),
      ...(c.favorite && { favorite: true }),
    });
  const hidden = topics.filter((t) => t.hidden).map((t) => t.id);
  return [
    '{',
    '  "topics": {',
    topics.map((t) => `    ${JSON.stringify(t.id)}: ${JSON.stringify(t.name)}`).join(',\n'),
    '  },',
    ...(hidden.length ? [`  "hiddenTopics": ${value(hidden)},`] : []),
    '  "channels": [',
    channels.map((c) => `    ${line(c)}`).join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

export const exportChannels = (db) => formatChannelsFile({ topics: db.listTopics(), channels: db.listChannels() });

// channels.json is the user's own list and is not tracked; without it the database starts empty and stays unseeded,
// so a channels.json added before the first channel still seeds it.
export function openSeededDb(file = process.env.SUBFEED_DB || DB_PATH, seedPath = CHANNELS_PATH) {
  const db = openDb(file);
  if (!existsSync(seedPath)) return db;
  if (db.seedChannels(() => parseChannelsFile(readFileSync(seedPath, 'utf8')))) console.log(`Imported channels from ${seedPath}`);
  return db;
}
