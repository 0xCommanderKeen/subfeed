import { DAY, isoBefore } from '../../public/groups.js';
import { kindSql } from '../../public/kinds.js';
import { VIDEO_ID, spacedWords } from '../../public/vocab.js';
import { SUBSCRIBED } from './filters.mjs';

// Stores videos and their descriptions; runs inside the caller's transaction.
export function videoWriter(db, stamp) {
  const upsert = db.prepare(`
    INSERT INTO videos (id, channel_id, title, title_words, published, thumbnail, is_short, views, duration_s, kind, first_seen, updated_at, announce)
    SELECT :id, :channelId, :title, :titleWords, :published, :thumbnail, :isShort, :views, :durationS, :kind, :now, :now, :announce
    -- A refresh or backfill still in flight when its channel is deleted must not bring the videos back.
    WHERE EXISTS (SELECT 1 FROM channels WHERE id = :channelId)
    ON CONFLICT (id) DO UPDATE SET
      channel_id = excluded.channel_id,
      title = excluded.title,
      title_words = excluded.title_words,
      published = excluded.published,
      thumbnail = excluded.thumbnail,
      is_short = excluded.is_short,
      views = coalesce(excluded.views, views),
      duration_s = coalesce(excluded.duration_s, duration_s),
      kind = coalesce(excluded.kind, kind),
      updated_at = excluded.updated_at
  `);

  const videoExists = db.prepare('SELECT 1 FROM videos WHERE id = ?');
  // One statement per batch: FTS5 writes the index's pending rows to disk at the start of every statement that can
  // roll back alone, and that write gets slower as the index grows, so one statement per description slowed a backfill
  // from 30 ms to 600 ms per 500 descriptions over the first 20k videos.
  const upsertDescriptions = db.prepare(`
    INSERT INTO video_descriptions (video_id, description)
    SELECT d.value ->> 'id', d.value ->> 'description' FROM json_each(:rows) d
    WHERE EXISTS (SELECT 1 FROM videos WHERE id = d.value ->> 'id')
    ON CONFLICT (video_id) DO UPDATE SET description = excluded.description WHERE description IS NOT excluded.description
  `);

  // Without `announce`, the videos it inserts are never announced: a backfill stores old uploads.
  function writeVideos(videos, { announce = false } = {}) {
    const now = stamp();
    const insertedIds = [];
    const descriptions = [];
    for (const v of videos) {
      if (!VIDEO_ID.test(v.id ?? '')) continue;
      const { id, channelId, title, description = null, published, thumbnail, isShort, views, durationS, kind = null } = v;
      const existed = videoExists.get(id);
      const { changes } = upsert.run({ id, channelId, title, titleWords: spacedWords(title), published, thumbnail, isShort: isShort ? 1 : 0, views, durationS, kind, now, announce: announce ? 1 : 0 });
      if (description !== null) descriptions.push({ id, description });
      if (!existed && changes) insertedIds.push(id);
    }
    if (descriptions.length) upsertDescriptions.run({ rows: JSON.stringify(descriptions) });
    return { insertedIds };
  }

  return writeVideos;
}

export function videos(db, tx, writeVideos, stamp) {
  // Without an API key kind is unknown, so an upcoming premiere cannot be told apart and is announced.
  const toAnnounce = db.prepare(`
    SELECT v.id, v.title, v.thumbnail, c.name AS channelName FROM videos v
    JOIN channels c ON c.id = v.channel_id AND c.favorite = 1 AND c.subscribed = 1
    WHERE v.announce = 1 AND v.notified_at IS NULL AND v.first_seen >= :since
      AND v.is_short = 0
      AND ${kindSql('announceable')}
    ORDER BY v.published, v.id
  `);
  const setNotified = db.prepare('UPDATE videos SET notified_at = ? WHERE id = ?');

  // Live and upcoming videos have no duration yet, so they stay queued; unavailable (deleted or private) ones leave
  // once they were published before :unavailableSince, because YouTube can leave out a video that is still processing.
  // Newest first, so new uploads get their duration before old gaps are filled.
  const missingDetails = db.prepare(`
    SELECT id, isShort FROM (
      SELECT v.id, v.is_short AS isShort, v.published FROM videos v INDEXED BY videos_missing_details
      ${SUBSCRIBED}
      WHERE v.duration_s IS NULL AND ${kindSql('needsDetails')}
      UNION ALL
      SELECT v.id, v.is_short, v.published FROM videos v INDEXED BY videos_published
      ${SUBSCRIBED}
      WHERE v.published >= :unavailableSince AND v.kind = 'unavailable'
    )
    ORDER BY published DESC, id DESC
    LIMIT :limit
  `);
  // videos.list returns the view count with the details, so a count it brings is fresh.
  const updateDetails = db.prepare(`
    UPDATE videos SET duration_s = :durationS, views = coalesce(:views, views), kind = :kind, updated_at = :now,
      stats_at = CASE WHEN :views IS NULL THEN stats_at ELSE :now END
    WHERE id = :id
  `);
  // Subscribed channels' videos published since :since whose view count is older than :staleBefore, never-counted first.
  const staleStats = db.prepare(`
    SELECT v.id FROM videos v INDEXED BY videos_published
    ${SUBSCRIBED}
    WHERE v.published >= :since AND coalesce(v.stats_at, '') < :staleBefore AND v.kind IS NOT 'unavailable'
    ORDER BY v.stats_at IS NOT NULL, v.stats_at, v.published DESC, v.id DESC
    LIMIT :limit
  `);
  // Whether a video that the stats refresh keeps counted has a count older than :staleBefore. A video never counted
  // is as old as its publish time, so one that just arrived does not make the counts stale before its first refresh.
  const anyStaleStats = db.prepare(`
    SELECT 1 FROM videos v INDEXED BY videos_published
    ${SUBSCRIBED}
    WHERE v.published >= :since AND coalesce(v.stats_at, v.published) < :staleBefore AND v.kind IS NOT 'unavailable'
    LIMIT 1
  `);
  const updateStats = db.prepare('UPDATE videos SET views = coalesce(:views, views), stats_at = :now WHERE id = :id');
  const addUnits = db.prepare('INSERT INTO api_units (day, units) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET units = units + excluded.units');
  const unitsOn = db.prepare('SELECT units FROM api_units WHERE day = ?');
  const channelsWithVideos = db.prepare('SELECT DISTINCT channel_id AS id FROM videos');
  const videosWithDuration = db.prepare('SELECT id FROM videos WHERE id IN (SELECT value FROM json_each(?)) AND duration_s IS NOT NULL');

  return {
    // Without `announce`, the videos this call inserts are never announced. Rows it only updates keep their `announce`.
    upsertVideos(videos, { announce = false } = {}) {
      return tx(() => writeVideos(videos, { announce }));
    },

    videosWithDuration(ids) {
      return new Set(videosWithDuration.all(JSON.stringify(ids)).map((r) => r.id));
    },

    // Uploads first stored in the last 24 hours, so one that ntfy refused for longer is dropped rather than sent late.
    uploadsToAnnounce() {
      return toAnnounce.all({ since: isoBefore(stamp(), DAY) });
    },

    markNotified(ids) {
      const now = stamp();
      tx(() => {
        for (const id of ids) setNotified.run(now, id);
      });
    },

    videosMissingDetails({ unavailableSince, limit }) {
      return missingDetails.all({ unavailableSince, limit }).map((r) => ({ id: r.id, isShort: r.isShort === 1 }));
    },

    // views null keeps the stored count.
    applyDetails(details) {
      const now = stamp();
      tx(() => {
        for (const { id, durationS, views, kind } of details) updateDetails.run({ id, durationS, views, kind, now });
      });
    },

    videosNeedingStats({ since, staleBefore, limit }) {
      return staleStats.all({ since, staleBefore, limit }).map((r) => r.id);
    },

    statsFreshSince({ since, staleBefore }) {
      return anyStaleStats.get({ since, staleBefore }) === undefined;
    },

    // A null `views` keeps the stored count.
    applyStats(stats) {
      const now = stamp();
      tx(() => {
        for (const { id, views } of stats) updateStats.run({ id, views, now });
      });
    },

    addApiUnits(day, units) {
      addUnits.run(day, units);
    },

    apiUnitsOn(day) {
      return unitsOn.get(day)?.units ?? 0;
    },

    channelsWithVideos() {
      return new Set(channelsWithVideos.all().map((r) => r.id));
    },
  };
}
