import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fillMissingAvatars } from './avatars.mjs';
import { fillMissingDetails, refreshViewCounts } from './backfill.mjs';
import { backfillQueue } from './backfill-queue.mjs';
import { scheduleBackups, scheduleOptimize } from './backup.mjs';
import { withErrorBoundary } from './error-boundary.mjs';
import { openSeededDb } from './channels-file.mjs';
import { loadEnv } from './env.mjs';
import { DB_PATH, LENGTH_FILTER, topicGroup } from './db.mjs';
import { fetchChannelFeeds, videoUrl } from './feed.mjs';
import { hotSince, hotStaleBefore, withVelocity } from './hot.mjs';
import { allowedHosts, DEFAULT_HOST, guarded } from './http-guard.mjs';
import { sendJson } from './http-io.mjs';
import { EXAMPLES_PER_TOPIC, backfillUnits, claudeSuggester, keywordSuggestions, parseSubscriptionsCsv } from './import-subs.mjs';
import { INSTRUCTIONS, subfeedTools } from './mcp-tools.mjs';
import { mcpHandler } from './mcp.mjs';
import pkg from '../package.json' with { type: 'json' };
import { notifyNewUploads, ntfySender } from './notify.mjs';
import { refreshFeeds } from './refresh.mjs';
import { searchWorker } from './search-worker.mjs';
import { HttpError, arrayOf, bool, decodePath, flag, int, known, matching, oneOf, optional, nullable, parseRequest, pathPattern, type } from './request.mjs';
import { INPUT_HELP, lookupChannels, parseChannelInput, resolveVideo } from './resolve.mjs';
import { subscribeChannel, LookupError } from './subscribe.mjs';
import { visibleCount } from '../public/groups.js';
import { parseShared } from '../public/share-link.js';
import { CHANNEL_ID, MAX_QUERY, VIDEO_ID, wordsOf } from '../public/vocab.js';
import { dbMeter, fetchApi, meteredApi, unitsToday } from './youtube-api.mjs';

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');
const REFRESH_EVERY_MS = 30 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 5000;
const MAX_PATTERN = 100;
const MAX_CHANNEL_INPUT = 300;
const MAX_TOPIC_NAME = 60;
const MAX_PER_CHANNEL = 50;
const MAX_IMPORT_NAME = 200;
// A week, in seconds, well past the length of any video.
const MAX_POSITION = 7 * 24 * 60 * 60;
// Up to 1,000 videos get their duration per refresh; at most 20 units every 30 minutes.
const DETAIL_CALLS_PER_REFRESH = 20;
// Up to 500 view counts per refresh for Hot; each count is looked up again after STATS_MAX_AGE_MS.
const STATS_CALLS_PER_REFRESH = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// A page cursor is a base64url JSON array. `read(fields)` returns what the fields stand for, or undefined when they are
// not a valid cursor.
const cursor = (read) => ({
  encode: (...fields) => Buffer.from(JSON.stringify(fields)).toString('base64url'),
  decode(s) {
    let value;
    try {
      value = read(JSON.parse(Buffer.from(s, 'base64url').toString()));
    } catch {}
    if (value === undefined) throw new HttpError(400, 'invalid cursor');
    return value;
  },
});
const isTime = (t) => typeof t === 'string' && !Number.isNaN(Date.parse(t));

// The [publish time, id] of the last row on the page, so the next page starts after it.
const newestCursor = cursor(([published, id]) => (isTime(published) && VIDEO_ID.test(id) ? { published, id } : undefined));
// The [latest upload, channel id] of the last shelf on the page.
const shelfCursor = cursor(([latest, channelId]) => (isTime(latest) && CHANNEL_ID.test(channelId) ? { latest, channelId } : undefined));
// A Hot page is an offset into the ranking at a fixed time, so later pages rank the same way as the first.
const hotCursor = cursor(([now, offset]) => (isTime(now) && Number.isInteger(offset) && offset >= 0 ? { now, offset } : undefined));
// A search page is ranked, so its cursor is the [rank, publish time, id] of the last row.
const searchCursor = cursor(([rank, published, id]) => (Number.isFinite(rank) && isTime(published) && VIDEO_ID.test(id) ? { rank, published, id } : undefined));

// Only subscribed channels are candidates, so an unsubscribed channel's videos never appear. The topic stays, as its
// rules apply.
const inGroup = ({ topic = null, channel = null, favoriteChannels = false, ...filters }, channels) => ({
  ...filters,
  topic,
  channelIds: channels
    .filter((c) => c.subscribed && (!topic || c.topics.includes(topic)) && (!channel || c.id === channel) && (!favoriteChannels || c.favorite))
    .map((c) => c.id),
});

const withLinks = (v, byId) => ({ ...v, channelName: byId.get(v.channelId).name, url: videoUrl(v.id, v.isShort) });

const videoId = matching(VIDEO_ID, 'a video id');
const channelId = matching(CHANNEL_ID, 'a channel id');
const knownTopic = known('topic', (v, { catalog }) => catalog().topics.some((t) => t.id === v));
const knownChannel = known('channel', (v, { catalog }) => catalog().byId.has(v));
const knownGroup = known('group', (v, { catalog }) => ['all', 'favorite-channels', ...catalog().topics.map((t) => topicGroup(t.id))].includes(v));
const subscribedChannel = type('be a subscribed channel id', (v, { catalog }) => (catalog().byId.get(v)?.subscribed ? v : undefined));
const topicIds = arrayOf(knownTopic, 'existing topic ids');
const search = type(`be at most ${MAX_QUERY} characters`, (v) => (v.trim().length <= MAX_QUERY ? v.trim() || null : undefined));
const anyString = (must) => type(`be ${must}`, (v) => (typeof v === 'string' ? v : undefined));
const isoDate = type('be an ISO date', (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined));
const topicName = type(`be 1 to ${MAX_TOPIC_NAME} characters`, (v) => {
  const name = typeof v === 'string' ? v.trim() : '';
  return name && name.length <= MAX_TOPIC_NAME ? name : undefined;
});
const rulePattern = type(`hold a word and be at most ${MAX_PATTERN} characters`, (v) => {
  const pattern = typeof v === 'string' ? v.trim() : '';
  return wordsOf(pattern).length && pattern.length <= MAX_PATTERN ? pattern : undefined;
});
const sharedVideo = type('be a YouTube video link', (v) => {
  const shared = typeof v === 'string' && v.length <= 2000 ? parseShared(v) : null;
  return shared?.kind === 'video' ? shared : undefined;
});
// A channel from an import preview. Its name, handle and avatar come from the client, so a bad one is dropped.
const importChannel = type('be a channel', (item, ctx) => {
  if (!item || typeof item !== 'object' || !CHANNEL_ID.test(item.id)) return undefined;
  const topics = topicIds.parse(item.topics ?? [], ctx);
  if (!topics) return undefined;
  const name = typeof item.name === 'string' ? item.name.trim().slice(0, MAX_IMPORT_NAME) : '';
  const handle = typeof item.handle === 'string' && /^@\S{1,100}$/.test(item.handle) ? item.handle : null;
  const avatar = typeof item.avatar === 'string' && item.avatar.startsWith('https://') ? item.avatar : null;
  return { channel: { id: item.id, name: name || item.id, handle, avatar }, topics };
});

const SHORTS = optional(oneOf(['include', 'exclude', 'only']), 'include');
const STREAMS = optional(oneOf(['include', 'exclude']), 'include');
const FILTERS_QUERY = {
  topic: optional(knownTopic, null),
  favoriteChannels: optional(flag, false),
  favorites: optional(flag, false),
  queued: optional(flag, false),
  shorts: SHORTS,
  streams: STREAMS,
  watched: optional(oneOf(['include', 'exclude']), 'include'),
  muted: optional(oneOf(['hide', 'show']), 'hide'),
  length: optional(oneOf(Object.keys(LENGTH_FILTER)), 'any'),
};
const VIDEOS_QUERY = {
  ...FILTERS_QUERY,
  channel: optional(subscribedChannel, null),
  sort: optional(oneOf(['newest', 'hot']), 'newest'),
  q: optional(search, null),
  limit: optional(int(1, 200), 60),
  before: optional(anyString('a cursor'), null),
};
const SHELVES_QUERY = {
  ...FILTERS_QUERY,
  perChannel: optional(int(1, MAX_PER_CHANNEL), 12),
  channels: optional(int(1, 100), 20),
  after: optional(anyString('a cursor'), null),
};

// The query's names for the filters of db.listVideos.
const videoFilters = ({ favorites, queued, ...filters }) => ({ ...filters, favoritesOnly: favorites, queuedOnly: queued });

async function serveStatic(pathname, res) {
  let rel;
  try {
    rel = normalize(decodePath(pathname === '/' ? '/index.html' : pathname));
  } catch (err) {
    return send(res, err.status, 'text/plain', err.message);
  }
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + '/')) return send(res, 403, 'text/plain', 'Forbidden');
  try {
    send(res, 200, MIME[extname(file)] ?? 'application/octet-stream', await readFile(file));
  } catch {
    send(res, 404, 'text/plain', 'Not found');
  }
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

// `hosts` is the set of Host values the server answers to. Without an API key, `fetchPage` loads YouTube channel and
// watch pages, for avatars, adding a channel and shared videos. Without `suggestGroups`, imported channels get topics by keyword.
export function createApp({
  db, fetchFeeds, hosts, fetchPage, api = null, notify = null, suggestGroups = null,
  wait = (ms, signal) => sleep(ms, undefined, { signal }),
  // db.searchPage, or the same run elsewhere such as searchWorker; it may return a promise and take an AbortSignal.
  search = (query) => db.searchPage(query),
}) {
  if (!fetchPage) throw new Error('createApp needs fetchPage: pass fetch, or a fake in tests so none reaches youtube.com');
  const { now } = db;
  const apiMeter = api && dbMeter(db, api);
  // channelId -> { ok, error?, failedRuns, lastFetched }; absent until the channel's first fetch finishes. failedRuns
  // counts the fetches in a row that failed: one slow refresh, such as the first after a restart, often times out a few.
  const channelStatus = new Map();
  const fetchStatus = (id) => channelStatus.get(id) ?? { ok: null, failedRuns: 0, lastFetched: null };
  const backfills = backfillQueue({ db, apiMeter, wait });
  let lastRefresh = null;
  // Data API units the last refresh spent on video details; null before the first refresh.
  let lastRefreshUnits = null;
  // Concurrent triggers share one run instead of each fetching every feed.
  let pendingRefresh = null;

  // The database is the source of truth. Reading it per request keeps every view current with no cache to invalidate.
  function catalog() {
    const topics = db.listTopics();
    const channels = db.listChannels();
    return { topics, channels, byId: new Map(channels.map((c) => [c.id, c])) };
  }

  function recordStatus(id, error) {
    const previous = channelStatus.get(id);
    channelStatus.set(id, error
      ? { ok: false, error, failedRuns: (previous?.failedRuns ?? 0) + 1, lastFetched: previous?.lastFetched ?? null }
      : { ok: true, failedRuns: 0, lastFetched: now().toISOString() });
  }

  // Refreshing one channel (added or resubscribed) never notifies: only the refresh of every channel does.
  const refreshChannel = (id) => refreshFeeds(db, [id], { fetchFeeds, onChannel: recordStatus });

  // One lookup step of a refresh. `step(api)` gets the Data API, or null without a key, and returns how many `noun` it
  // filled. Returns the units the step spent; a failure is logged, not thrown.
  async function lookupStep(what, noun, step) {
    const meter = apiMeter && meteredApi(apiMeter.api);
    const units = () => meter?.unitsSinceStart ?? 0;
    try {
      const filled = await step(meter?.api ?? null);
      if (filled) console.log(`${what}: ${filled} ${noun}, ${units()} units`);
    } catch (err) {
      console.error(`${what} lookup failed after ${units()} units: ${err.message}`);
    }
    return units();
  }

  // A backfill paused for quota stores nothing until it resumes, so its channel's new uploads are still announced.
  const isBackfilling = (id) => backfills.storingChannelIds().includes(id);

  async function announce() {
    if (!notify) return;
    try {
      const sent = await notifyNewUploads({ db, send: notify });
      if (sent) console.log(`ntfy: sent ${sent} notification${sent === 1 ? '' : 's'}`);
    } catch (err) {
      console.error(`ntfy failed: ${err.message}`);
    }
  }

  async function runRefresh() {
    const subscribed = catalog().channels.filter((c) => c.subscribed);
    const ids = subscribed.map((c) => c.id);
    // Only a favorite's uploads wait to be announced, so favoriting a channel later does not announce its last day.
    const favorites = new Set(subscribed.filter((c) => c.favorite).map((c) => c.id));
    const failed = [];
    const onChannel = (id, error) => {
      recordStatus(id, error);
      if (error) failed.push(`${id} (${error})`);
    };
    await refreshFeeds(db, ids, { fetchFeeds, onChannel, announce: (id) => favorites.has(id) && !isBackfilling(id) });
    if (failed.length) console.error(`refresh: ${failed.length} of ${ids.length} channels failed: ${failed.join(', ')}`);
    // Details first, so kind can rule out upcoming premieres before anything is announced; their lookups count views too.
    lastRefreshUnits =
      (await lookupStep('video details', 'videos', (api) => api && fillMissingDetails({ db, api, maxCalls: DETAIL_CALLS_PER_REFRESH }))) +
      (await lookupStep('view counts', 'videos', (api) => api && refreshViewCounts({ db, api, maxCalls: STATS_CALLS_PER_REFRESH }))) +
      (await lookupStep('channel avatars', 'channels', (api) => fillMissingAvatars({ db, api, fetchImpl: fetchPage })));
    lastRefresh = now().toISOString();
    await announce();
  }

  function refresh() {
    pendingRefresh ??= runRefresh().finally(() => {
      pendingRefresh = null;
    });
    return pendingRefresh;
  }

  function meta() {
    const stats = db.channelStats();
    const { topics, channels } = catalog();
    const subscribed = channels
      .filter((c) => c.subscribed)
      .map(({ id, name, handle, avatar, topics, favorite }) => ({
        id,
        name,
        handle,
        avatar,
        topics,
        favorite,
        backfill: backfills.status(id).state,
        ...fetchStatus(id),
        ...stats.get(id),
      }));
    const totalVideos = subscribed.reduce((n, c) => n + visibleCount(c.raw.counts, false), 0);
    return {
      topics: topics.map(({ id, name, hidden }) => ({ id, name, hidden })),
      channels: subscribed,
      favoriteChannels: subscribed.filter((c) => c.favorite).length,
      visits: db.listVisits(),
      rules: db.listRules(),
      lastRefresh,
      totalVideos,
      hot: hasFreshCounts(now().toISOString()),
      apiUnits: { lastRefresh: lastRefreshUnits, today: unitsToday(db) },
    };
  }

  function channelView(channel, stats = db.channelStats()) {
    const backfill = backfills.status(channel.id);
    const { counts, latest } = stats.get(channel.id);
    return {
      ...channel,
      counts,
      latest,
      ...fetchStatus(channel.id),
      backfill: backfill.state,
      backfillDetail: backfill.detail,
    };
  }

  function listChannels() {
    const stats = db.channelStats();
    const { topics, channels } = catalog();
    return {
      topics,
      channels: channels.map((c) => channelView(c, stats)),
      backfillAvailable: apiMeter !== null,
      apiUnits: apiMeter?.unitsSinceStart ?? 0,
    };
  }

  // Views per hour, the flame, and Hot need view counts that the stats refresh keeps current: an API key, and no
  // count in the window older than STATS_STALE_MS.
  const hasFreshCounts = (at) => apiMeter !== null && db.statsFreshSince({ since: hotSince(at), staleBefore: hotStaleBefore(at) });

  function withVelocities(videos, at) {
    if (!hasFreshCounts(at)) return videos;
    const usual = db.usualRates({ channelIds: [...new Set(videos.map((v) => v.channelId))], since: hotSince(at), now: at });
    return videos.map((v) => withVelocity(v, usual.get(`${v.channelId}:${v.isShort}`), at));
  }

  // Hot is never shown with stale view counts.
  function listHot(query, byId) {
    if (!apiMeter) throw new HttpError(503, 'sort=hot needs YOUTUBE_API_KEY; see the README');
    if (!hasFreshCounts(now().toISOString())) throw new HttpError(503, 'sort=hot needs fresh view counts; the last lookups failed or have not run yet');
    const { now: at, offset } = query.before ?? { now: now().toISOString(), offset: 0 };
    const { videos, more } = db.listHot({ ...query, since: hotSince(at), now: at, offset });
    return {
      videos: withVelocities(videos, at).map((v) => withLinks(v, byId)),
      nextCursor: more ? hotCursor.encode(at, offset + videos.length) : null,
    };
  }

  // The filters of VIDEOS_QUERY, already checked and renamed by videoFilters.
  function queryVideos(filters) {
    const cat = catalog();
    const query = inGroup(filters, cat.channels);
    if (query.sort === 'hot') return listHot(query, cat.byId);
    const { videos, more } = db.listVideos(query);
    const last = videos.at(-1);
    return {
      videos: withVelocities(videos, now().toISOString()).map((v) => withLinks(v, cat.byId)),
      nextCursor: more ? newestCursor.encode(last.published, last.id) : null,
    };
  }

  // The filters of queryVideos with `q` and `offset?`. The first page also says how many videos match in all, up to
  // MATCH_COUNT_CAP, with `totalCapped` when more do.
  async function searchVideos(filters, signal) {
    const cat = catalog();
    const { videos, more, total, totalCapped } = await search(inGroup(filters, cat.channels), signal);
    const last = videos.at(-1);
    return {
      videos: withVelocities(videos, now().toISOString()).map(({ rank, ...v }) => withLinks(v, cat.byId)),
      nextCursor: more ? searchCursor.encode(last.rank, last.published, last.id) : null,
      total,
      totalCapped,
    };
  }

  // `before` is a Hot cursor with sort=hot, a search cursor with q, and a newest-first cursor otherwise.
  function listVideos({ before, ...query }, signal) {
    if (query.q && query.sort === 'hot') throw new HttpError(400, 'search results are sorted best match first');
    const codec = query.sort === 'hot' ? hotCursor : query.q ? searchCursor : newestCursor;
    const filters = videoFilters({ ...query, before: before ? codec.decode(before) : null });
    return query.q ? searchVideos(filters, signal) : queryVideos(filters);
  }

  // For the MCP tools: one bounded query instead of paging listVideos back to `since`.
  function newVideos(filters) {
    const { channels, byId } = catalog();
    const { videos, total } = db.newVideos(inGroup(filters, channels));
    return { videos: videos.map((v) => withLinks(v, byId)), total };
  }

  // Shelves come in pages of `channels` channels; pass `nextCursor` as `after` for the next page.
  function listShelves({ perChannel, channels, after: token, ...query }) {
    const cat = catalog();
    const after = token ? shelfCursor.decode(token) : null;
    const { shelves, next } = db.listShelfPage({ ...inGroup(videoFilters(query), cat.channels), perChannel, channels, after });
    return {
      shelves: shelves.map(({ channelId, latest, videos }) => ({ channelId, latest, videos: videos.map((v) => withLinks(v, cat.byId)) })),
      nextCursor: next ? shelfCursor.encode(next.latest, next.channelId) : null,
    };
  }

  // Like every list, the queue holds only subscribed channels' videos.
  function listQueue({ shorts, streams, order }) {
    const byId = catalog().byId;
    return { videos: db.listQueue({ shorts, streams, order }).map((v) => withLinks(v, byId)) };
  }

  function recordVisit({ group, seenAt }) {
    db.markVisit(group, seenAt);
    return { group, seenAt: db.listVisits()[group] };
  }

  function existingChannel(id) {
    const channel = catalog().byId.get(id);
    if (!channel) throw new HttpError(404, `no channel ${id}`);
    return channel;
  }

  // `topics` are existing topic ids; the HTTP route and the MCP tool both check them.
  async function subscribeChannelRequest({ input, topics }) {
    if (input.length > MAX_CHANNEL_INPUT) throw new HttpError(400, INPUT_HELP);
    const ref = parseChannelInput(input);
    if (!ref) throw new HttpError(400, `Not a channel handle or URL. ${INPUT_HELP}`);
    let result;
    try {
      result = await subscribeChannel(db, ref, topics, { api: apiMeter?.api, fetchPage, fetchFeeds, onChannel: recordStatus });
    } catch (err) {
      if (err instanceof LookupError) throw new HttpError(502, `Could not reach YouTube: ${err.message}`);
      throw err;
    }
    if (!result) throw new HttpError(404, `No YouTube channel found for ${input.trim()}`);
    const { created, channel } = result;
    if (created) backfills.start(channel);
    return { created, channel: channelView(existingChannel(channel.id)) };
  }

  // Topics with a few of their channels' names, so suggestions can judge a topic by what it already holds.
  function topicsWithExamples({ topics, channels }) {
    return topics.map((t) => ({
      id: t.id,
      name: t.name,
      examples: channels.filter((c) => c.topics.includes(t.id)).slice(0, EXAMPLES_PER_TOPIC).map((c) => c.name),
    }));
  }

  // subscriptions.csv -> the channels not in subfeed yet, each with suggested topics and its backfill's unit estimate.
  async function previewImport({ csv }) {
    let listed;
    try {
      listed = parseSubscriptionsCsv(csv);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const cat = catalog();
    const fresh = listed.filter((c) => !cat.byId.has(c.id));
    let found = null;
    const lookup = apiMeter && meteredApi(apiMeter.api);
    if (lookup && fresh.length) {
      try {
        found = await lookupChannels(fresh.map((c) => c.id), lookup.api);
      } catch (err) {
        throw new HttpError(502, `Could not look the channels up on YouTube: ${err.message}`);
      }
    }
    // Without a key there is no lookup: the CSV's title is all there is, and every channel is kept.
    const channels = fresh
      .filter((c) => !found || found.has(c.id))
      .map((c) => ({ id: c.id, name: c.title, handle: null, avatar: null, description: '', videoCount: null, ...found?.get(c.id) }));
    const topics = topicsWithExamples(cat);
    let suggestedBy = 'keywords';
    let suggestError = null;
    let groups = keywordSuggestions(channels, topics);
    let newGroups = [];
    if (suggestGroups && channels.length) {
      try {
        const suggested = await suggestGroups({ channels, topics });
        groups = channels.map((c) => suggested.groups.get(c.id) ?? []);
        newGroups = suggested.newGroups;
        suggestedBy = 'claude';
      } catch (err) {
        console.error(`import suggestions from Claude failed: ${err.message}`);
        suggestError = err.message;
      }
    }
    return {
      channels: channels.map(({ description, ...c }, i) => ({ ...c, topics: groups[i], backfillUnits: apiMeter ? backfillUnits(c.videoCount) : 0 })),
      listed: listed.length,
      alreadyIn: listed.length - fresh.length,
      notFound: fresh.length - channels.length,
      lookupUnits: lookup?.unitsSinceStart ?? 0,
      suggestedBy,
      suggestError,
      newGroups,
      backfillAvailable: apiMeter !== null,
    };
  }

  // Adds the channels that are not in subfeed yet, stores their RSS videos, and queues one backfill each.
  // Channels already in subfeed are skipped, so importing the same file twice adds nothing.
  async function importChannels({ channels: items }) {
    const { byId } = catalog();
    const added = [];
    for (const { channel, topics } of items) {
      if (byId.has(channel.id) || added.some((c) => c.id === channel.id)) continue;
      db.subscribeChannel(channel, topics);
      added.push(channel);
    }
    await refreshFeeds(db, added.map((c) => c.id), { fetchFeeds, onChannel: recordStatus });
    for (const channel of added) backfills.start(channel);
    return { added: added.length, skipped: items.length - added.length, backfillsQueued: apiMeter ? added.length : 0 };
  }

  // A video shared from another app goes to the end of Watch Later. A video subfeed has not stored yet is looked up,
  // and stored when its channel is in subfeed. Otherwise nothing changes, and the answer names the channel to add.
  async function shareVideo({ url: shared }) {
    const { byId } = catalog();
    let video = db.getVideo(shared.id);
    if (!video) {
      let found;
      try {
        found = await resolveVideo(shared.id, shared.isShort, { api: apiMeter?.api, fetchImpl: fetchPage });
      } catch (err) {
        throw new HttpError(502, `Could not reach YouTube: ${err.message}`);
      }
      if (!found) throw new HttpError(404, `No YouTube video ${shared.id}`);
      const { channelName, ...row } = found;
      if (!byId.has(row.channelId)) {
        const channel = { id: row.channelId, name: channelName, subscribed: false };
        return { queued: false, video: { ...row, channelName, url: videoUrl(row.id, row.isShort) }, channel };
      }
      db.upsertVideos([row]);
      video = db.getVideo(row.id);
    }
    db.enqueue(video.id);
    const { id, name, subscribed } = byId.get(video.channelId);
    return { queued: true, video: withLinks(video, byId), channel: { id, name, subscribed } };
  }

  // A field left undefined keeps its value.
  function updateChannel(id, { subscribed, favorite, topics }) {
    const updated = db.updateChannel(id, { subscribed, favorite, topics });
    if (!updated) throw new HttpError(404, `no channel ${id}`);
    if (subscribed === false) backfills.cancel(id);
    if (subscribed && !updated.wasSubscribed) refreshChannel(id).catch((err) => console.error(`refresh of ${id} failed: ${err.message}`));
    return channelView(existingChannel(id));
  }

  // The video changes of both the HTTP routes and the MCP tools. Each caller has checked that `id` is a video id.
  function knownVideo(id) {
    if (!db.getVideo(id)) throw new HttpError(404, `no video ${id} in subfeed`);
  }

  const linkedVideo = (id) => withLinks(db.getVideo(id), catalog().byId);

  function setVideoFavorite(id, on) {
    knownVideo(id);
    db.setFavorite(id, on);
    return linkedVideo(id);
  }

  // Without `before` the video goes to the end of the queue, unless it is queued already.
  function setVideoQueued(id, on, before) {
    knownVideo(id);
    if (!on) db.unqueueVideo(id);
    else if (before === undefined) db.enqueue(id);
    else db.moveInQueue(id, before);
    return linkedVideo(id);
  }

  function setVideoWatched(id, on) {
    knownVideo(id);
    if (on) db.markWatched([id]);
    else db.markUnwatched(id);
  }

  function setVideoPosition(id, seconds) {
    knownVideo(id);
    if (seconds === null) db.clearPosition(id);
    else db.savePosition(id, seconds);
  }

  function deleteChannel(id) {
    backfills.cancel(id);
    channelStatus.delete(id);
    if (!db.deleteChannel(id)) throw new HttpError(404, `no channel ${id}`);
  }

  function backfillRoute(id) {
    const channel = existingChannel(id);
    if (!apiMeter) throw new HttpError(503, 'YOUTUBE_API_KEY is not set; see the README');
    if (!channel.subscribed) throw new HttpError(409, 'resubscribe the channel first');
    backfills.start(channel);
    return channelView(channel);
  }

  function updateTopic({ id, ...changes }) {
    db.updateTopic(id, changes);
    return db.listTopics().find((t) => t.id === id);
  }

  // A mute rule may name a channel, a topic or neither; a route rule names both.
  function createRule({ kind, pattern, channel, topic }) {
    if (kind === 'route' && (channel === null || topic === null)) throw new HttpError(400, 'a route rule needs a channel and a topic');
    return db.addRule({ kind, pattern, channelId: channel, topicId: topic });
  }

  function deleteRule({ id }) {
    if (!db.deleteRule(id)) throw new HttpError(404, `no rule ${id}`);
  }

  // Each route declares its path `params`, `query` and `body` fields; see parseRequest. The handler gets them as one
  // object of checked values, and an AbortSignal for a client that goes away. A handler returning undefined answers 204.
  // Every route has a row in the Routes table of docs/api.md.
  const ID = { id: channelId };
  const VIDEO = { videoId };
  const TOPIC = { id: knownTopic };
  const ROUTES = [
    { method: 'GET', path: '/api/meta', handler: () => meta() },
    { method: 'GET', path: '/api/videos', query: VIDEOS_QUERY, handler: listVideos },
    { method: 'GET', path: '/api/shelves', query: SHELVES_QUERY, handler: listShelves },
    { method: 'PUT', path: '/api/visits/:group', params: { group: knownGroup }, body: { seenAt: isoDate }, handler: recordVisit },
    { method: 'POST', path: '/api/refresh', handler: async () => (await refresh(), meta()) },
    { method: 'GET', path: '/api/channels', handler: () => listChannels() },
    {
      method: 'POST', path: '/api/channels', body: { input: anyString('a channel handle or URL'), topics: optional(topicIds, []) },
      handler: subscribeChannelRequest,
    },
    { method: 'POST', path: '/api/import/preview', body: { csv: anyString('the text of subscriptions.csv') }, handler: previewImport },
    {
      method: 'POST', path: '/api/import', body: { channels: arrayOf(importChannel, 'channels, each with a channel id and existing topic ids') },
      handler: importChannels,
    },
    {
      method: 'PATCH', path: '/api/channels/:id', params: ID, body: { subscribed: optional(bool), favorite: optional(bool), topics: optional(topicIds) },
      handler: ({ id, ...changes }) => updateChannel(id, changes),
    },
    { method: 'DELETE', path: '/api/channels/:id', params: ID, handler: ({ id }) => deleteChannel(id) },
    { method: 'POST', path: '/api/channels/:id/backfill', params: ID, handler: ({ id }) => backfillRoute(id) },
    { method: 'POST', path: '/api/topics', body: { name: topicName }, handler: ({ name }) => db.createTopic(name) },
    {
      method: 'PATCH', path: '/api/topics/:id', params: TOPIC, body: { name: optional(topicName), position: optional(int(0)), hidden: optional(bool) },
      handler: updateTopic,
    },
    { method: 'DELETE', path: '/api/topics/:id', params: TOPIC, handler: ({ id }) => void db.deleteTopic(id) },
    {
      method: 'POST', path: '/api/topics/:id/channels', params: TOPIC,
      body: { channels: arrayOf(knownChannel, 'existing channel ids', { nonEmpty: true }), linked: bool },
      handler: ({ id, channels, linked }) => ({ changed: db.setTopicOnChannels(id, channels, linked) }),
    },
    { method: 'GET', path: '/api/rules', handler: () => ({ rules: db.listRules() }) },
    {
      method: 'POST', path: '/api/rules',
      body: { kind: oneOf(['mute', 'route']), pattern: rulePattern, channel: optional(nullable(knownChannel), null), topic: optional(nullable(knownTopic), null) },
      handler: createRule,
    },
    { method: 'DELETE', path: '/api/rules/:id', params: { id: int(1) }, handler: deleteRule },
    { method: 'PUT', path: '/api/favorites/:videoId', params: VIDEO, handler: ({ videoId }) => void setVideoFavorite(videoId, true) },
    { method: 'DELETE', path: '/api/favorites/:videoId', params: VIDEO, handler: ({ videoId }) => void setVideoFavorite(videoId, false) },
    { method: 'GET', path: '/api/queue', query: { shorts: SHORTS, streams: STREAMS, order: optional(oneOf(['queue', 'newest', 'oldest']), 'queue') }, handler: listQueue },
    {
      method: 'PUT', path: '/api/queue/:videoId', params: VIDEO, body: { before: optional(nullable(videoId)) }, optionalBody: true,
      handler: ({ videoId, before }) => void setVideoQueued(videoId, true, before),
    },
    { method: 'DELETE', path: '/api/queue/:videoId', params: VIDEO, handler: ({ videoId }) => void setVideoQueued(videoId, false) },
    { method: 'POST', path: '/api/share', body: { url: sharedVideo }, handler: shareVideo },
    { method: 'PUT', path: '/api/watched/:videoId', params: VIDEO, handler: ({ videoId }) => void setVideoWatched(videoId, true) },
    { method: 'DELETE', path: '/api/watched/:videoId', params: VIDEO, handler: ({ videoId }) => void setVideoWatched(videoId, false) },
    { method: 'PUT', path: '/api/position/:videoId', params: VIDEO, body: { seconds: int(1, MAX_POSITION) }, handler: ({ videoId, seconds }) => void setVideoPosition(videoId, seconds) },
    { method: 'DELETE', path: '/api/position/:videoId', params: VIDEO, handler: ({ videoId }) => void setVideoPosition(videoId, null) },
  ].map((route) => ({ ...route, pattern: pathPattern(route.path) }));

  async function handleApi(req, res, url) {
    const matches = ROUTES.map((route) => ({ route, match: url.pathname.match(route.pattern) })).filter(({ match }) => match);
    if (!matches.length) return sendJson(res, 404, { error: 'not found' });
    const found = matches.find(({ route }) => route.method === req.method);
    if (!found) return sendJson(res, 405, { error: 'method not allowed' }, { Allow: [...new Set(matches.map(({ route }) => route.method))].join(', ') });
    // Aborts when the client goes away before the answer, so a search still waiting for its turn is dropped.
    const gone = new AbortController();
    res.once('close', () => res.writableFinished || gone.abort());
    try {
      const result = await found.route.handler(await parseRequest(found.route, { match: found.match, req, url, catalog }), gone.signal);
      if (result === undefined) send(res, 204, 'text/plain', '');
      else sendJson(res, 200, result);
    } catch (err) {
      if (gone.signal.aborted) return;
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(`${req.method} ${url.pathname} failed: ${err.stack ?? err}`);
      sendJson(res, 500, { error: 'internal error' });
    }
  }

  const handleMcp = mcpHandler({
    name: 'subfeed',
    version: pkg.version,
    instructions: INSTRUCTIONS,
    tools: subfeedTools({ meta, queryVideos, searchVideos, newVideos, queue: (shorts) => listQueue({ shorts, streams: 'include' }).videos, subscribeChannel: subscribeChannelRequest, updateChannel, setVideoFavorite, setVideoQueued, now }),
  });

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, 'text/plain', 'malformed request target');
    }
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname === '/mcp') return handleMcp(req, res);
    await serveStatic(url.pathname, res);
  }

  return { handle: withErrorBoundary(guarded(handle, { hosts })), refresh, routes: ROUTES, stopBackfills: backfills.stop };
}

function main() {
  loadEnv();
  const port = process.env.PORT ? Number(process.env.PORT) : 4173;
  const host = process.env.HOST || DEFAULT_HOST;
  const dbPath = process.env.SUBFEED_DB || DB_PATH;
  const db = openSeededDb(dbPath);
  const searcher = searchWorker(dbPath);
  const apiKey = process.env.YOUTUBE_API_KEY || null;
  const notify = process.env.NTFY_URL ? ntfySender({ topicUrl: process.env.NTFY_URL, token: process.env.NTFY_TOKEN || null }) : null;
  // Filled once the server listens, so PORT=0 allows the port it was given. No request arrives before then.
  const hosts = new Set();
  const app = createApp({
    db,
    fetchFeeds: fetchChannelFeeds,
    hosts,
    fetchPage: fetch,
    api: apiKey ? fetchApi(apiKey) : null,
    notify,
    suggestGroups: process.env.ANTHROPIC_API_KEY ? claudeSuggester(process.env.ANTHROPIC_API_KEY) : null,
    search: searcher.search,
  });
  const logRefresh = () => app.refresh().catch((err) => console.error(`refresh failed: ${err.message}`));
  let closing = false;
  const server = http.createServer((req, res) => {
    // server.close() drops only idle connections. One busy at shutdown would stay open for keepAliveTimeout after it answers.
    res.once('close', () => closing && server.closeIdleConnections());
    return app.handle(req, res);
  });
  server.listen(port, host, () => {
    const bound = server.address().port;
    for (const allowed of allowedHosts(process.env.ALLOWED_HOSTS, bound)) hosts.add(allowed);
    console.log(`subfeed running at http://localhost:${bound}`);
  });
  logRefresh();
  const refreshTimer = setInterval(logRefresh, REFRESH_EVERY_MS);
  const stopOptimize = scheduleOptimize(db);
  const stopBackups = scheduleBackups(db, {
    dir: join(dirname(dbPath), 'backups'),
    onFailure: (err) => notify?.({ title: 'subfeed backup failed', body: err.message, priority: 'high', tags: 'warning' }),
  });

  // As PID 1 in the container, Node gets no default SIGTERM action, so without this `docker stop` ends in SIGKILL.
  const shutdown = (signal) => {
    console.log(`${signal}: shutting down`);
    closing = true;
    setTimeout(() => {
      console.error(`shutdown took over ${SHUTDOWN_GRACE_MS / 1000} s, exiting anyway`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    clearInterval(refreshTimer);
    stopOptimize();
    stopBackups();
    app.stopBackfills();
    server.close(async () => {
      await searcher.close();
      db.close();
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (import.meta.main) main();
