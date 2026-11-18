import { DAY, HOUR, buildGroups, defaultBaseline, groupSize, isoBefore, visibleCount } from '../public/groups.js';
import { KINDS } from '../public/kinds.js';
import { parseShared, withScheme } from '../public/share-link.js';
import { MAX_QUERY, VIDEO_ID, fold, formatAge, formatDuration } from '../public/vocab.js';

export const INSTRUCTIONS =
  'subfeed lists the videos of hand-picked YouTube channels, grouped by topic. Start with list_groups. ' +
  'Each video is one line: title · channel · age · length · URL, with ★ in front of a favorite. Shorts are left out unless asked for.';

const MAX_NEW = 50;
const MAX_SEARCH = 30;
const MAX_CHANNEL_VIDEOS = 50;
const SPAN = /^(\d+)\s*([hdw])$/i;
const SPAN_MS = { h: HOUR, d: DAY, w: 7 * DAY };
const MAX_SPAN_YEARS = 10;

export function formatLength({ kind, durationS }) {
  if (KINDS[kind]?.needsDetails) return kind;
  return durationS === null || durationS === undefined ? null : formatDuration(durationS);
}

export const videoLine = (v, now) =>
  [`${v.favorite ? '★ ' : ''}${v.title}`, v.channelName, formatAge(v.published, now), formatLength(v), v.url].filter((part) => part !== null).join(' · ');

export function parseSince(text, now) {
  const s = String(text).trim();
  const span = s.match(SPAN);
  if (span) {
    const ms = Number(span[1]) * SPAN_MS[span[2].toLowerCase()];
    if (ms > MAX_SPAN_YEARS * 365 * DAY) throw new Error(`since can reach back at most ${MAX_SPAN_YEARS} years, not "${s}"`);
    return isoBefore(now, ms);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  throw new Error(`since must be an ISO date such as 2026-11-01, or a span such as 24h, 7d or 2w, not "${s}"`);
}

export function videoIdFrom(input) {
  const s = String(input ?? '').trim();
  if (VIDEO_ID.test(s)) return s;
  const shared = parseShared(withScheme(s));
  return shared?.kind === 'video' ? shared.id : null;
}

const groupName = (g) => (g.starred ? `★ ${g.label}` : g.label);

export function findGroup(groups, input, noun = 'group') {
  const s = String(input ?? '').trim();
  const byId = groups.find((g) => g.id === s || g.id === `topic:${s}`);
  if (byId) return byId;
  const want = fold(s.replace(/^★\s*/, ''));
  const named = groups.filter((g) => fold(g.label) === want || fold(g.title) === want);
  if (named.length === 1) return named[0];
  const listed = (named.length ? named : groups).map((g) => `${g.id} (${groupName(g)})`).join(', ');
  throw new Error(`${named.length ? 'Ambiguous' : 'Unknown'} ${noun} "${s}". ${named.length ? 'It could be' : `The ${noun}s are`}: ${listed}`);
}

export function findChannel(channels, input) {
  const s = String(input ?? '').trim();
  const want = fold(s);
  const exact = channels.filter((c) => c.id === s || (c.handle && [fold(c.handle), fold(c.handle).slice(1)].includes(want)) || fold(c.name) === want);
  const found = exact.length ? exact : want ? channels.filter((c) => fold(c.name).includes(want)) : [];
  if (found.length === 1) return found[0];
  const listed = (found.length ? found : channels).map((c) => `${c.name} (${c.handle ?? c.id})`).join(', ');
  throw new Error(found.length ? `"${s}" matches several channels: ${listed}` : `No subscribed channel matches "${s}". The channels are: ${listed}`);
}

const ordinal = (n) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${suffix}`;
};

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const lastVisit = (group, meta) => (group.tracksNew ? meta.visits[group.id] : undefined);
const shortsMode = (includeShorts) => (includeShorts ? 'include' : 'exclude');
const groupFilter = ({ params }, includeShorts) => ({
  topic: params.topic ?? null,
  favoriteChannels: params.favoriteChannels === '1',
  favoritesOnly: params.favorites === '1',
  queuedOnly: params.queued === '1',
  shorts: shortsMode(includeShorts),
});

const READ = { readOnlyHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false };
const GROUP = {
  type: 'string',
  description: 'A group id from list_groups (all, favorite-channels, favorites, watch-later, topic:<id>), a topic id, or a group or topic name.',
};
const CHANNEL = { type: 'string', description: 'A subscribed channel: its id (UC…), its @handle, or its name.' };
const INCLUDE_SHORTS = { type: 'boolean', description: 'Include Shorts. Default false.' };
const VIDEO = { type: 'string', description: 'An 11-character video id, or a YouTube URL holding it (watch?v=, youtu.be/, /shorts/).' };
// Past MAX_SAFE_INTEGER SQLite binds the offset as a float and refuses it with a bare "datatype mismatch".
const OFFSET = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'How many videos to skip, to fetch the ones after an earlier answer. Default 0.' };
const rest = (total, offset, shown) => {
  const more = total - offset - shown;
  return more > 0 ? [`… and ${more} more. Call again with offset: ${offset + shown}.`] : [];
};
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function subfeedTools({ meta, queryVideos, searchVideos, newVideos, queue, subscribeChannel, updateChannel, setVideoFavorite, setVideoQueued, now }) {
  const current = () => {
    const m = meta();
    return { m, groups: buildGroups(m) };
  };

  const line = (v) => videoLine(v, now());

  const queueState = (v) => {
    if (!v.queued) return 'not in Watch Later';
    const at = queue(shortsMode(v.isShort)).findIndex((q) => q.id === v.id);
    if (at === -1) return 'in Watch Later';
    return `in Watch Later (${ordinal(at + 1)}${v.isShort ? ' counting Shorts' : ''})`;
  };

  return [
    {
      name: 'list_groups',
      title: 'List groups',
      description:
        'Lists the groups of the subfeed sidebar: Everything, one per topic, ★ Channels (favorite channels), ★ Videos (starred videos) and Watch Later (the queue of videos to watch next). ' +
        'Each line has the group id, name, channel count, video count without Shorts, and how many videos are new since the group was last opened.',
      inputSchema: object({}),
      annotations: READ,
      run() {
        const { m, groups } = current();
        const baseline = defaultBaseline(now());
        return groups
          .map((g) => {
            const parts = [g.id, groupName(g)];
            if (g.channels) parts.push(count(m.channels.filter(g.channels).length, 'channel'));
            parts.push(count(groupSize(g, m, { hideShorts: true }), 'video'));
            if (g.tracksNew) parts.push(`${newVideos({ ...groupFilter(g, false), since: lastVisit(g, m) ?? baseline, limit: 0 }).total} new`);
            return parts.join(' · ');
          })
          .join('\n');
      },
    },
    {
      name: 'new_videos',
      title: 'New videos',
      description:
        "Lists a group's videos published after `since`, newest first, at most 50; `offset` fetches the ones after those. " +
        'By default `since` is when the group was last opened in subfeed, or 3 days ago, the same as the NEW badge. Does not mark the group as seen.',
      inputSchema: object(
        {
          group: GROUP,
          since: { type: 'string', description: 'An ISO date such as 2026-11-01, or a span back from now such as 24h, 7d or 2w.' },
          include_shorts: INCLUDE_SHORTS,
          offset: OFFSET,
        },
        ['group'],
      ),
      annotations: READ,
      run({ group, since, include_shorts = false, offset = 0 }) {
        const { m, groups } = current();
        const g = findGroup(groups, group);
        const visit = lastVisit(g, m);
        const from = since === undefined ? (visit ?? defaultBaseline(now())) : parseSince(since, now());
        const basis = since !== undefined ? '' : visit ? ' (last visit)' : ' (3 days ago, no visit yet)';
        const { videos, total } = newVideos({ ...groupFilter(g, include_shorts), since: from, limit: MAX_NEW, offset });
        if (!total) return `Nothing new in ${groupName(g)} since ${from}${basis}.`;
        const head = `${total} new in ${groupName(g)} since ${from}${basis}`;
        if (!videos.length) return `${head}, none after offset ${offset}.`;
        return [`${head}:`, ...videos.map(line), ...rest(total, offset, videos.length)].join('\n');
      },
    },
    {
      name: 'search',
      title: 'Search video titles and descriptions',
      description:
        'Searches video titles and descriptions in a group, best match first, at most 30; `offset` fetches the ones after those. A word in the title counts more than one in the description. Each word must start a word in the title or description, in any order; case and accents do not matter.',
      inputSchema: object({ query: { type: 'string', maxLength: MAX_QUERY, description: 'The words to look for.' }, group: { ...GROUP, description: `${GROUP.description} Default all.` }, include_shorts: INCLUDE_SHORTS, offset: OFFSET }, ['query']),
      annotations: READ,
      async run({ query, group = 'all', include_shorts = false, offset = 0 }) {
        const q = query.trim();
        if (!q) throw new Error('query must have at least one word');
        const g = findGroup(current().groups, group);
        const { videos, total, totalCapped, nextCursor } = await searchVideos({ ...groupFilter(g, include_shorts), q, limit: MAX_SEARCH, offset });
        if (!total) return `No videos in ${groupName(g)} match "${q}".`;
        const head = `${totalCapped ? `More than ${total}` : total} in ${groupName(g)} match "${q}"`;
        if (!videos.length) return `${head}, none after offset ${offset}.`;
        const after = totalCapped && nextCursor ? [`… and more. Call again with offset: ${offset + videos.length}.`] : rest(total, offset, videos.length);
        return [`${head}:`, ...videos.map(line), ...after].join('\n');
      },
    },
    {
      name: 'channel_videos',
      title: 'Channel videos',
      description: "Lists a subscribed channel's newest videos, 20 by default, at most 50.",
      inputSchema: object({ channel: CHANNEL, limit: { type: 'integer', minimum: 1, maximum: MAX_CHANNEL_VIDEOS, description: `How many videos to list, 1 to ${MAX_CHANNEL_VIDEOS}. Default 20.` }, include_shorts: INCLUDE_SHORTS }, ['channel']),
      annotations: READ,
      run({ channel, limit = 20, include_shorts: shorts = false }) {
        const c = findChannel(current().m.channels, channel);
        const { videos } = queryVideos({ channel: c.id, shorts: shortsMode(shorts), limit });
        const head = `${c.favorite ? '★ ' : ''}${c.name} (${c.handle ?? c.id}) · ${count(visibleCount(c.counts, !shorts), 'video')}`;
        return [head, ...(videos.length ? videos.map(line) : ['No videos stored.'])].join('\n');
      },
    },
    {
      name: 'watch_later_queue',
      title: 'Watch Later queue',
      description: 'Lists the Watch Later queue in queue order, the next video to watch first, whatever its age.',
      inputSchema: object({ include_shorts: INCLUDE_SHORTS }),
      annotations: READ,
      run({ include_shorts }) {
        const videos = queue(shortsMode(include_shorts));
        if (!videos.length) return 'Watch Later is empty.';
        return [`${count(videos.length, 'video')} in Watch Later, next first:`, ...videos.map(line)].join('\n');
      },
    },
    {
      name: 'favorite_video',
      title: 'Star a video',
      description: 'Changes subfeed: stars a video, so it shows in ★ Videos, or removes the star with favorite false.',
      inputSchema: object(
        {
          video: VIDEO,
          favorite: { type: 'boolean', description: 'false removes the star. Default true.' },
        },
        ['video'],
      ),
      annotations: { ...WRITE, idempotentHint: true },
      run({ video, favorite = true }) {
        const id = videoIdFrom(video);
        if (!id) throw new Error(`"${video}" is not a video id or a YouTube video URL`);
        const v = setVideoFavorite(id, favorite);
        return `${line(v)} · ${v.favorite ? 'starred' : 'not starred'}`;
      },
    },
    {
      name: 'watch_later',
      title: 'Watch Later',
      description:
        'Changes subfeed: adds a video to the end of the Watch Later queue, or takes it off with queued false. A video already in the queue keeps its place.',
      inputSchema: object({ video: VIDEO, queued: { type: 'boolean', description: 'false takes the video off the queue. Default true.' } }, ['video']),
      annotations: { ...WRITE, idempotentHint: true },
      run({ video, queued = true }) {
        const id = videoIdFrom(video);
        if (!id) throw new Error(`"${video}" is not a video id or a YouTube video URL`);
        const v = setVideoQueued(id, queued);
        return `${line(v)} · ${queueState(v)}`;
      },
    },
    {
      name: 'favorite_channel',
      title: 'Star a channel',
      description: 'Changes subfeed: makes a channel a favorite, so its videos show in ★ Channels, or removes it with favorite false.',
      inputSchema: object({ channel: CHANNEL, favorite: { type: 'boolean', description: 'false removes the star. Default true.' } }, ['channel']),
      annotations: { ...WRITE, idempotentHint: true },
      run({ channel, favorite = true }) {
        const c = findChannel(current().m.channels, channel);
        const updated = updateChannel(c.id, { favorite });
        return updated.favorite ? `★ ${updated.name} is a favorite channel.` : `${updated.name} is not a favorite channel.`;
      },
    },
    {
      name: 'add_channel',
      title: 'Add a channel',
      description:
        'Changes subfeed: subscribes to a YouTube channel in the given topics and stores its latest videos. ' +
        'A channel already in the list is resubscribed and gets the topics added. Topics must exist; this never creates one.',
      inputSchema: object(
        {
          input: { type: 'string', description: '@handle, handle, https://www.youtube.com/@handle or https://www.youtube.com/channel/UC…' },
          groups: { type: 'array', items: { type: 'string' }, description: 'Topic names or ids, as list_groups shows them.' },
        },
        ['input', 'groups'],
      ),
      annotations: { ...WRITE, openWorldHint: true },
      async run({ input, groups }) {
        const { m, groups: all } = current();
        const topicGroups = all.filter((g) => g.params.topic);
        const topics = groups.map((name) => findGroup(topicGroups, name, 'topic').params.topic);
        const { created, channel } = await subscribeChannel({ input, topics });
        const names = channel.topics.map((id) => m.topics.find((t) => t.id === id)?.name).join(', ') || 'no topic';
        const history = channel.backfill === 'running' || channel.backfill === 'queued' ? ' Its full history is loading in the background.' : '';
        const name = `${channel.name} (${channel.handle ?? channel.id})`;
        const done = created ? `Added ${name} in ${names}.` : `${name} was already in subfeed. It is subscribed in ${names}.`;
        return `${done} ${count(visibleCount(channel.counts, true), 'video')} stored.${history}`;
      },
    },
  ];
}
