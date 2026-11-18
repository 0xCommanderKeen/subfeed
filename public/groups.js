// The groups both pages navigate by. No DOM here, so the tests import it directly.
import { kindOf } from './kinds.js';
import { titleHas } from './vocab.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
// The ISO time `ms` before `now`, a Date, an ISO time or epoch milliseconds.
export const isoBefore = (now, ms) => new Date(new Date(now).getTime() - ms).toISOString();
// With no recorded visit for a group, videos from the last few days count as new.
const FIRST_VISIT_LOOKBACK = 3 * DAY;
export const defaultBaseline = (now) => isoBefore(now, FIRST_VISIT_LOOKBACK);

export const bucketOf = (v) => (v.isShort ? 'short' : kindOf(v.kind).isStream ? 'stream' : 'long');

export const visibleCount = (counts, hideShorts, hideStreams = false) => counts.long + (hideShorts ? 0 : counts.short) + (hideStreams ? 0 : counts.stream);
// A channel's tallies, as the server splits them: all its videos, or with Hide watched only the unwatched ones.
export const shownTallies = (c, hideWatched) => (hideWatched ? c.unwatched : c);
// A channel's tallies in `group` under the rules: those of the group's topic where its rules touch the channel,
// else those outside a topic group. Show muted counts every video.
export const ruledTallies = (c, group, showMuted = false) => (showMuted ? c.raw : c.inTopic[group.params.topic] ?? c);

// Whether `rules` hide the video in the group of `topic`, null outside a topic group. The same test as hiddenSql in src/db/filters.mjs.
export function ruleHides(rules, v, topic) {
  const matches = (r) => titleHas(v.title, r.pattern);
  const mine = rules.filter((r) => r.channelId === null || r.channelId === v.channelId);
  if (mine.some((r) => r.kind === 'mute' && (r.topicId === null || r.topicId === topic) && matches(r))) return true;
  const routes = mine.filter((r) => r.kind === 'route' && r.topicId === topic);
  return routes.length > 0 && !routes.some(matches);
}

// Each of a channel's tally sets with the topic whose rules it follows: null outside a topic group, undefined for none.
export const tallySets = (c) => [[c, null], [c.raw, undefined], ...Object.entries(c.inTopic).map(([topic, t]) => [t, topic])];

const MARK_TALLY = { favorite: 'starred', queued: 'queued' };
// Sets a star (`favorite`) or Watch Later (`queued`) mark on the video and keeps its channel's tallies in step.
// Every tally set counts the mark, as the rules leave those lists alone. Setting a mark the video already has
// changes nothing, so undoing a failed request after a second click cannot count it twice. Returns whether it changed.
export function setMark(v, channel, mark, on) {
  if (v[mark] === on) return false;
  v[mark] = on;
  const delta = on ? 1 : -1;
  for (const [t] of tallySets(channel)) {
    for (const s of v.watched ? [t] : [t, t.unwatched]) s[MARK_TALLY[mark]][bucketOf(v)] += delta;
  }
  return true;
}

// sort() would order null after any date, so drop it first.
export const latestVisible = (c, hideShorts, hideStreams = false) =>
  [c.latest.long, hideShorts ? null : c.latest.short, hideStreams ? null : c.latest.stream].filter(Boolean).sort().at(-1) ?? '';

// `params` select a group's videos on the API, `channels` picks its channels for the chip row (null hides the row),
// `tally` says which of a channel's counts make up the group's size, and `tracksNew` whether it has a last-visit baseline.
// `keepsWatched` marks the group that Hide watched leaves alone: the queue lists watched videos too.
// Starred groups and the Watch Later queue sit in the sidebar's Library, between Everything and the topics;
// `queue` marks the one ordered by hand. A `hidden` topic sits in the sidebar's More fold instead of the topic list.
export function buildGroups(meta) {
  const marks = monograms(meta.topics.map((t) => t.name));
  return [
    { id: 'all', label: 'Everything', title: 'Everything', params: {}, channels: () => true, tally: (c) => c.counts, tracksNew: true },
    ...meta.topics.map(({ id, name, hidden }, i) => ({
      id: `topic:${id}`, label: name, title: name, monogram: marks[i], hidden, params: { topic: id },
      channels: (c) => c.topics.includes(id), tally: (c) => c.counts, tracksNew: true,
    })),
    {
      id: 'favorite-channels', label: 'Channels', starred: true, library: true, title: 'Favorite channels', params: { favoriteChannels: '1' },
      channels: (c) => c.favorite, tally: (c) => c.counts, tracksNew: true,
      empty: ['No favorite channels yet', 'Star a channel on its shelf or its page, and its videos collect here.'],
    },
    {
      id: 'favorites', label: 'Videos', starred: true, library: true, title: 'Favorite videos', params: { favorites: '1' },
      channels: null, tally: (c) => c.starred, tracksNew: false,
      empty: ['No favorite videos yet', 'Star any video and it lands here.'],
    },
    {
      id: 'watch-later', label: 'Watch Later', library: true, queue: true, title: 'Watch Later', params: { queued: '1' },
      channels: null, tally: (c) => c.queued, tracksNew: false, keepsWatched: true,
      empty: ['Nothing to watch later', 'Click the clock on any video to queue it here. A video comes off once it ends or opens on YouTube.'],
    },
  ];
}

// A channel's tallies in `group` under `filters`, the switches of filters.js. Hide watched leaves the queue alone.
const filteredTallies = (c, group, { hideWatched = false, showMuted = false }) => shownTallies(ruledTallies(c, group, showMuted), hideWatched && !group.keepsWatched);

export function groupSize(group, meta, filters) {
  const channels = group.channels ? meta.channels.filter(group.channels) : meta.channels;
  return channels.reduce((n, c) => n + visibleCount(group.tally(filteredTallies(c, group, filters)), filters.hideShorts, filters.hideStreams), 0);
}

export function groupHasNew(group, meta, filters) {
  if (!group.tracksNew) return false;
  const since = meta.visits[group.id] ?? defaultBaseline(Date.now());
  return meta.channels.filter(group.channels).some((c) => latestVisible(filteredTallies(c, group, filters), filters.hideShorts, filters.hideStreams) > since);
}

// Whether `after` lacks a channel that `before` had, as after an unsubscribe in another tab.
export const dropsChannel = (before, after) => [...before.keys()].some((id) => !after.has(id));

// Marking Everything seen covers every group that tracks new videos, so their dots clear with it.
export const groupsMarkedSeen = (group, groups) => (group.id === 'all' ? groups.filter((g) => g.tracksNew) : [group]);

// Two-character marks for the compact sidebar, unique across `names` and assigned in order, so a topic keeps
// its mark until one before it changes. A short leading word is kept whole ("3D"), then the initials of the
// first two words ("MP"), then the first letter with each later letter, then the first letter with a digit.
export function monograms(names) {
  const taken = new Set();
  return names.map((name) => {
    const words = name.toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const letters = [...words.join('')];
    if (!letters.length) letters.push('?');
    const [first] = letters;
    const candidates = [
      words.length > 1 && words[0].length <= 2 ? words[0] : null,
      words.length > 1 ? words[0][0] + words[1][0] : null,
      ...letters.slice(1).map((ch) => first + ch),
      ...'23456789'.split('').map((d) => first + d),
    ];
    const mark = candidates.find((c) => c && !taken.has(c)) ?? `${first}${taken.size}`;
    taken.add(mark);
    return mark;
  });
}
