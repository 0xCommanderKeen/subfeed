import { CHANNEL_ID, fold, wordsOf } from '../public/vocab.js';
import { PLAYLIST_KINDS } from './feed.mjs';
import { MAX_PER_CALL } from './youtube-api.mjs';

const MIN_NEW_GROUP = 3;
export const CLAUDE_MODEL = 'claude-opus-5-5';
const CLAUDE_CHANNELS_PER_CALL = 200;
const DESCRIPTION_CHARS = 300;
export const EXAMPLES_PER_TOPIC = 8;

// RFC 4180: quoted fields may hold commas, doubled quotes and line breaks.
function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') field += text[++i];
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

export function parseSubscriptionsCsv(text) {
  const [header = [], ...rows] = csvRows(String(text).replace(/^﻿/, ''));
  const column = (name) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const idAt = column('channel id');
  const titleAt = column('channel title');
  if (idAt < 0) throw new Error('Not a subscriptions.csv: it needs the columns Channel Id, Channel Url, Channel Title');
  const seen = new Set();
  const channels = [];
  for (const row of rows) {
    const id = row[idAt]?.trim();
    if (!CHANNEL_ID.test(id ?? '') || seen.has(id)) continue;
    seen.add(id);
    channels.push({ id, title: row[titleAt]?.trim() || id });
  }
  return channels;
}

// A backfill reads every uploads list, one playlistItems and one videos call per 50 videos.
// The first page of each list costs a call even when it is empty or missing.
export const backfillUnits = (videoCount) => 2 * Math.ceil((videoCount ?? 0) / MAX_PER_CALL) + PLAYLIST_KINDS.length;

const STOPWORDS = new Set(['and', 'the', 'for', 'with', 'of', 'en', 'und', 'der', 'die', 'das']);
const words = (s) => wordsOf(fold(s));
// "Printing" also finds "printer" and "prints", "Games" finds "game".
const stem = (w) => {
  const short = w.replace(/(ing|ers|er|es|s)$/, '');
  return short.length >= 3 ? short : w;
};

export function keywordSuggestions(channels, topics) {
  const stems = topics.map((t) => ({ id: t.id, stems: words(t.name).filter((w) => !STOPWORDS.has(w)).map(stem) }));
  return channels.map((c) => {
    const text = words(`${c.name} ${c.description ?? ''}`);
    return stems.filter((t) => t.stems.length && t.stems.some((s) => text.some((w) => w.startsWith(s)))).map((t) => t.id);
  });
}

const SYSTEM = `You sort YouTube channels into the user's topic groups for a video feed.
For each channel, pick the ids of every existing group it clearly fits, judged by its title and description and by the example channels already in each group. Pick none when nothing fits well.
If at least ${MIN_NEW_GROUP} channels fit no existing group and share a clear theme, propose a new group for them: a short name of one to three words and the ids of those channels. Propose no new group otherwise.`;

const SCHEMA = {
  type: 'object',
  properties: {
    channels: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, groups: { type: 'array', items: { type: 'string' } } },
        required: ['id', 'groups'],
        additionalProperties: false,
      },
    },
    newGroups: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, channelIds: { type: 'array', items: { type: 'string' } } },
        required: ['name', 'channelIds'],
        additionalProperties: false,
      },
    },
  },
  required: ['channels', 'newGroups'],
  additionalProperties: false,
};

// Asks Claude through the Messages API. The returned function takes channels [{ id, name, description }] and
// topics [{ id, name, examples }] and resolves to { groups: Map id -> topic ids, newGroups: [{ name, channelIds }] }.
export function claudeSuggester(key, fetchImpl = fetch) {
  async function ask(channels, topics) {
    const input = {
      groups: topics.map(({ id, name, examples }) => ({ id, name, exampleChannels: examples })),
      channels: channels.map(({ id, name, description }) => ({ id, title: name, description: (description ?? '').slice(0, DESCRIPTION_CHARS) })),
    };
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(input) }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Claude returned HTTP ${res.status}: ${body.error?.message ?? ''}`);
    if (body.stop_reason !== 'end_turn') throw new Error(`Claude stopped early (${body.stop_reason})`);
    return JSON.parse(body.content.find((b) => b.type === 'text').text);
  }

  return async ({ channels, topics }) => {
    const topicIds = new Set(topics.map((t) => t.id));
    const groups = new Map();
    const newGroups = new Map();
    for (let i = 0; i < channels.length; i += CLAUDE_CHANNELS_PER_CALL) {
      const batch = channels.slice(i, i + CLAUDE_CHANNELS_PER_CALL);
      const ids = new Set(batch.map((c) => c.id));
      const answer = await ask(batch, topics);
      for (const { id, groups: picked } of answer.channels) if (ids.has(id)) groups.set(id, [...new Set(picked.filter((t) => topicIds.has(t)))]);
      for (const { name, channelIds } of answer.newGroups) {
        const key = name.trim().toLowerCase();
        const group = newGroups.get(key) ?? { name: name.trim(), channelIds: [] };
        group.channelIds.push(...channelIds.filter((id) => ids.has(id) && !group.channelIds.includes(id)));
        newGroups.set(key, group);
      }
    }
    return { groups, newGroups: [...newGroups.values()].filter((g) => g.name && g.channelIds.length >= MIN_NEW_GROUP) };
  };
}

