import { kindSql } from '../../public/kinds.js';

export const SHORTS_FILTER = { include: null, exclude: 0, only: 1 };

// A Short stays a Short whatever its kind, so the stream counts and the Hide streams filter agree.
const IS_STREAM = `(v.is_short = 0 AND ${kindSql('isStream')})`;
export const HIDE_STREAMS = { include: 0, exclude: 1 };
export const NOT_STREAM = `(:hideStreams = 0 OR NOT ${IS_STREAM})`;
const HIDE_WATCHED = { include: 0, exclude: 1 };
// A video of unknown kind is long.
export const BUCKET = `CASE WHEN v.is_short = 1 THEN 'short' WHEN ${IS_STREAM} THEN 'stream' ELSE 'long' END`;

// True when the rules hide the video `v` in the group of topic `topic`, a SQL expression that is NULL outside a topic
// group. A mute rule hides matching titles everywhere, or only in its channel or in its topic's group. A channel with
// route rules for a topic shows in that topic's group only the videos whose title matches one of them.
// A rule matches as titleHas does: title_words and words hold spacedWords of the title and the pattern, folded once on
// write, because folding in a function per video and rule made every count and search seconds slower.
export const hiddenSql = (topic) => `(
  EXISTS (SELECT 1 FROM rules r WHERE r.kind = 'mute'
    AND (r.channel_id IS NULL OR r.channel_id = v.channel_id) AND (r.topic_id IS NULL OR r.topic_id = ${topic})
    AND instr(v.title_words, r.words) > 0)
  OR (EXISTS (SELECT 1 FROM rules r WHERE r.kind = 'route' AND r.channel_id = v.channel_id AND r.topic_id = ${topic})
    AND NOT EXISTS (SELECT 1 FROM rules r WHERE r.kind = 'route' AND r.channel_id = v.channel_id AND r.topic_id = ${topic}
      AND instr(v.title_words, r.words) > 0)))`;
const HIDDEN = hiddenSql(':ruleTopic');
// SQL value for the muted filter: 1 leaves out the videos the rules hide, 2 lists them marked muted, 0 ignores the rules.
// Starred videos and Watch Later are picked by hand, so the rules leave those lists alone.
const MUTED_FILTER = { hide: 1, show: 2 };

// Inclusive. A bound excludes videos of unknown duration.
export const LENGTH_FILTER = {
  any: { minS: null, maxS: null },
  short: { minS: null, maxS: 15 * 60 - 1 },
  medium: { minS: 15 * 60, maxS: 45 * 60 },
  long: { minS: 45 * 60 + 1, maxS: null },
};

// The joins that VIDEO_COLUMNS and VIDEO_FILTER read as f and w.
export const MARK_JOINS = `LEFT JOIN favorites f ON f.video_id = v.id
    LEFT JOIN watched w ON w.video_id = v.id`;
export const SUBSCRIBED = 'JOIN channels c ON c.id = v.channel_id AND c.subscribed = 1';

export const VIDEO_COLUMNS = `
  v.id, v.channel_id AS channelId, v.title, v.published, v.thumbnail, v.is_short AS isShort,
  v.views, v.duration_s AS durationS, v.kind,
  f.video_id IS NOT NULL AS favorite, w.video_id IS NOT NULL AS watched,
  EXISTS (SELECT 1 FROM queue q WHERE q.video_id = v.id) AS queued,
  (SELECT p.seconds FROM positions p WHERE p.video_id = v.id) AS position`;

export const VIDEO_FILTER = `
  v.channel_id IN (SELECT value FROM json_each(:channelIds))
  AND (:isShort IS NULL OR v.is_short = :isShort)
  AND ${NOT_STREAM}
  AND (:hideWatched = 0 OR NOT EXISTS (SELECT 1 FROM watched hw WHERE hw.video_id = v.id))
  AND (:favoritesOnly = 0 OR f.video_id IS NOT NULL)
  AND (:queuedOnly = 0 OR EXISTS (SELECT 1 FROM queue q WHERE q.video_id = v.id))
  AND (:minS IS NULL OR v.duration_s >= :minS)
  AND (:maxS IS NULL OR v.duration_s <= :maxS)
  AND (:rules <> 1 OR NOT ${HIDDEN})`;
// A listed video's columns, with whether Show muted revealed it.
export const LISTED_COLUMNS = `${VIDEO_COLUMNS}, (:rules = 2 AND ${HIDDEN}) AS muted`;

// `topic` is the topic group listed, whose rules apply; null in any other group.
export const filterParams = ({ channelIds, topic = null, shorts, streams = 'include', watched = 'include', muted = 'hide', favoritesOnly, queuedOnly = false, length = 'any' }) => ({
  channelIds: JSON.stringify(channelIds),
  isShort: SHORTS_FILTER[shorts],
  hideStreams: HIDE_STREAMS[streams],
  hideWatched: HIDE_WATCHED[watched],
  favoritesOnly: favoritesOnly ? 1 : 0,
  queuedOnly: queuedOnly ? 1 : 0,
  ...LENGTH_FILTER[length],
  ruleTopic: topic,
  rules: favoritesOnly || queuedOnly ? 0 : MUTED_FILTER[muted],
});

export const toVideo = (r) => ({
  id: r.id,
  channelId: r.channelId,
  title: r.title,
  published: r.published,
  thumbnail: r.thumbnail,
  isShort: r.isShort === 1,
  views: r.views,
  durationS: r.durationS,
  kind: r.kind,
  favorite: r.favorite === 1,
  watched: r.watched === 1,
  queued: r.queued === 1,
  position: r.position,
  ...(r.muted === 1 && { muted: true }),
});
