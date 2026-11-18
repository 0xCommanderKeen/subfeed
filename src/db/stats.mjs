import { BUCKET, hiddenSql } from './filters.mjs';

const emptyTallies = () => ({
  counts: { long: 0, short: 0, stream: 0 },
  latest: { long: null, short: null, stream: null },
  starred: { long: 0, short: 0, stream: 0 },
  queued: { long: 0, short: 0, stream: 0 },
});

function addTally(t, { bucket, n, latest, starred, queued }) {
  t.counts[bucket] += n;
  if (t.latest[bucket] === null || latest > t.latest[bucket]) t.latest[bucket] = latest;
  t.starred[bucket] += starred;
  t.queued[bucket] += queued;
}

const channelTallies = () => ({ ...emptyTallies(), unwatched: emptyTallies() });

// A video the rules hide leaves the counts but stays starred or queued, as those lists ignore the rules.
function addStatsRow(t, r, muted) {
  const row = muted ? { ...r, n: 0, latest: null } : r;
  addTally(t, row);
  if (!r.watched) addTally(t.unwatched, row);
}

export function stats(db) {
  const statRows = db.prepare(`
    SELECT c.id AS channelId, s.bucket, s.watched, s.muted,
           count(s.bucket) AS n, max(s.published) AS latest, count(s.starred) AS starred, count(s.queued) AS queued
    FROM channels c LEFT JOIN (
      SELECT v.channel_id AS channelId, v.published, ${BUCKET} AS bucket, w.video_id IS NOT NULL AS watched,
             ${hiddenSql('NULL')} AS muted, f.video_id AS starred, q.video_id AS queued
      FROM videos v
      LEFT JOIN favorites f ON f.video_id = v.id
      LEFT JOIN queue q ON q.video_id = v.id
      LEFT JOIN watched w ON w.video_id = v.id
    ) s ON s.channelId = c.id
    GROUP BY 1, 2, 3, 4
  `);
  // The same per channel and topic, for the links whose topic has a rule that can touch the channel.
  const topicStats = db.prepare(`
    SELECT ct.channel_id AS channelId, ct.topic_id AS topicId, ${BUCKET} AS bucket, w.video_id IS NOT NULL AS watched,
           ${hiddenSql('ct.topic_id')} AS muted,
           count(*) AS n, max(v.published) AS latest, count(f.video_id) AS starred, count(q.video_id) AS queued
    FROM channel_topics ct
    JOIN videos v ON v.channel_id = ct.channel_id
    LEFT JOIN favorites f ON f.video_id = v.id
    LEFT JOIN queue q ON q.video_id = v.id
    LEFT JOIN watched w ON w.video_id = v.id
    WHERE EXISTS (SELECT 1 FROM rules r WHERE r.topic_id = ct.topic_id AND (r.channel_id IS NULL OR r.channel_id = ct.channel_id))
    GROUP BY 1, 2, 3, 4, 5
  `);

  const statsVersion = db.prepare('SELECT n FROM stats_version');
  let statsCache = { version: null, stats: null };

  return {
    // The top-level tallies leave out the videos the rules hide outside a topic group. `raw` counts every video, for
    // Show muted. `inTopic` maps a topic id to the tallies in that topic's group, for the topics whose rules can touch
    // the channel; in its other topics the channel counts as outside a topic group.
    // The result is shared until the stats change, so callers must not modify it.
    channelStats() {
      const { n: version } = statsVersion.get();
      if (statsCache.version !== version) {
        const byChannel = new Map();
        for (const r of statRows.all()) {
          if (!byChannel.has(r.channelId)) byChannel.set(r.channelId, { ...channelTallies(), raw: channelTallies(), inTopic: {} });
          if (r.bucket === null) continue;
          const c = byChannel.get(r.channelId);
          addStatsRow(c, r, r.muted);
          addStatsRow(c.raw, r, false);
        }
        for (const r of topicStats.all()) {
          const { inTopic } = byChannel.get(r.channelId);
          inTopic[r.topicId] ??= channelTallies();
          addStatsRow(inTopic[r.topicId], r, r.muted);
        }
        statsCache = { version, stats: byChannel };
      }
      return statsCache.stats;
    },
  };
}
