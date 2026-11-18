import { kindSql } from '../../public/kinds.js';
import { fold, spacedWords } from '../../public/vocab.js';
import { HIDE_STREAMS, MARK_JOINS, NOT_STREAM, SHORTS_FILTER, SUBSCRIBED, VIDEO_COLUMNS, toVideo } from './filters.mjs';

// Topic ids are object keys in channels.json; an integer-like key would jump ahead of the others in JS key order.
export function slugify(name) {
  const slug = fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return 'topic';
  return /^\d+$/.test(slug) ? `t-${slug}` : slug;
}

// Visits are keyed by group: `all`, `favorite-channels`, or `topic:<id>`.
export const topicGroup = (topicId) => `topic:${topicId}`;

export function library(db, tx, stamp) {
  const visitRows = db.prepare('SELECT group_id AS groupId, seen_at AS seenAt FROM visits');
  // Two devices can report visits out of order; the later time wins.
  const upsertVisit = db.prepare(`
    INSERT INTO visits (group_id, seen_at) VALUES (?, ?)
    ON CONFLICT (group_id) DO UPDATE SET seen_at = max(seen_at, excluded.seen_at)
  `);
  const removeVisit = db.prepare('DELETE FROM visits WHERE group_id = ?');

  const videoRow = db.prepare(`
    SELECT ${VIDEO_COLUMNS}
    FROM videos v
    ${MARK_JOINS}
    WHERE v.id = ?
  `);
  const addFavorite = db.prepare('INSERT INTO favorites (video_id, added_at) VALUES (?, ?) ON CONFLICT DO NOTHING');
  const removeFavorite = db.prepare('DELETE FROM favorites WHERE video_id = ?');
  const queueRows = db.prepare(`
    SELECT ${VIDEO_COLUMNS}
    FROM queue qu
    CROSS JOIN videos v ON v.id = qu.video_id
    ${SUBSCRIBED}
    ${MARK_JOINS}
    WHERE (:isShort IS NULL OR v.is_short = :isShort) AND ${NOT_STREAM}
    ORDER BY qu.position, qu.added_at
  `);
  const queueOrder = db.prepare('SELECT video_id AS id FROM queue ORDER BY position, added_at');
  const addQueued = db.prepare(`
    INSERT INTO queue (video_id, added_at, position) SELECT ?, ?, coalesce((SELECT max(position) + 1 FROM queue), 0)
    ON CONFLICT DO NOTHING
  `);
  const setQueuePosition = db.prepare('UPDATE queue SET position = ? WHERE video_id = ?');
  const removeQueued = db.prepare('DELETE FROM queue WHERE video_id = ?');
  // An upcoming premiere cannot be watched yet, so it is never marked.
  const addWatched = db.prepare(`
    INSERT INTO watched (video_id, watched_at) SELECT :id, :now
    WHERE NOT EXISTS (SELECT 1 FROM videos WHERE id = :id AND NOT ${kindSql('watchable', 'kind')})
    ON CONFLICT DO NOTHING
  `);
  const removeWatched = db.prepare('DELETE FROM watched WHERE video_id = ?');
  const upsertPosition = db.prepare(`
    INSERT INTO positions (video_id, seconds, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (video_id) DO UPDATE SET seconds = excluded.seconds, updated_at = excluded.updated_at
  `);
  const removePosition = db.prepare('DELETE FROM positions WHERE video_id = ?');

  const channelRows = db.prepare(`
    SELECT c.id, c.name, c.handle, nullif(c.avatar, '') AS avatar, c.subscribed, c.favorite, c.added_at AS addedAt,
           (SELECT json_group_array(topic_id) FROM (SELECT topic_id FROM channel_topics WHERE channel_id = c.id ORDER BY rowid)) AS topics
    FROM channels c ORDER BY c.rowid
  `);
  const topicRows = db.prepare('SELECT id, name, position, hidden FROM topics ORDER BY position, rowid');
  const channelExists = db.prepare('SELECT 1 FROM channels WHERE id = ?');
  const channelSubscribed = db.prepare('SELECT subscribed FROM channels WHERE id = ?');
  const topicExists = db.prepare('SELECT 1 FROM topics WHERE id = ?');
  const insertChannel = db.prepare(`
    INSERT INTO channels (id, name, handle, avatar, subscribed, favorite, added_at) VALUES (:id, :name, :handle, :avatar, :subscribed, :favorite, :now)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, handle = coalesce(excluded.handle, handle), avatar = coalesce(excluded.avatar, avatar), subscribed = 1
  `);
  // avatar is NULL until looked up, and '' once a lookup found no picture, so that channel is not looked up again.
  const missingAvatar = db.prepare('SELECT id FROM channels WHERE subscribed = 1 AND avatar IS NULL ORDER BY rowid LIMIT ?');
  const setAvatar = db.prepare('UPDATE channels SET avatar = ? WHERE id = ?');
  const insertLink = db.prepare('INSERT INTO channel_topics (channel_id, topic_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
  const deleteLink = db.prepare('DELETE FROM channel_topics WHERE channel_id = ? AND topic_id = ?');
  const linkedTopics = db.prepare('SELECT topic_id AS id FROM channel_topics WHERE channel_id = ?');
  const setSubscribed = db.prepare('UPDATE channels SET subscribed = ? WHERE id = ?');
  const setChannelFavorite = db.prepare('UPDATE channels SET favorite = ? WHERE id = ?');
  const insertTopic = db.prepare(`
    INSERT INTO topics (id, name, position, hidden) VALUES (?, ?, coalesce(?, (SELECT max(position) + 1 FROM topics), 0), ?)
    ON CONFLICT DO NOTHING
  `);
  const renameTopic = db.prepare('UPDATE topics SET name = ? WHERE id = ?');
  const setTopicPosition = db.prepare('UPDATE topics SET position = ? WHERE id = ?');
  const setTopicHidden = db.prepare('UPDATE topics SET hidden = ? WHERE id = ?');
  // Foreign keys delete the channel's videos, their marks, its topic links and its rules.
  const removeChannelRow = db.prepare('DELETE FROM channels WHERE id = ?');
  // Foreign keys delete the topic's links and rules.
  const removeTopicRow = db.prepare('DELETE FROM topics WHERE id = ?');
  const ruleRows = db.prepare('SELECT id, kind, pattern, channel_id AS channelId, topic_id AS topicId FROM rules ORDER BY id');
  const insertRule = db.prepare('INSERT INTO rules (kind, pattern, words, channel_id, topic_id) VALUES (:kind, :pattern, :words, :channelId, :topicId)');
  const removeRule = db.prepare('DELETE FROM rules WHERE id = ?');
  const removeBackfill = db.prepare('DELETE FROM backfills WHERE channel_id = ?');

  const linkTopics = (channelId, topicIds) => {
    for (const topicId of topicIds) insertLink.run(channelId, topicId);
  };

  const listTopics = () => topicRows.all().map((r) => ({ id: r.id, name: r.name, position: r.position, hidden: r.hidden === 1 }));

  // `[{ id, kind, pattern, channelId, topicId }]`, oldest first. See hiddenSql in filters.mjs for what each kind does.
  const listRules = () => ruleRows.all().map((r) => ({ ...r }));

  return {
    listVisits() {
      return Object.fromEntries(visitRows.all().map((r) => [r.groupId, r.seenAt]));
    },

    // A device whose clock runs fast must not hide NEW on every device, so a visit never lands after `now`.
    markVisit(groupId, seenAt) {
      const now = stamp();
      upsertVisit.run(groupId, seenAt < now ? seenAt : now);
    },

    getVideo(id) {
      const row = videoRow.get(id);
      return row ? toVideo(row) : null;
    },

    setFavorite(videoId, on) {
      if (on) addFavorite.run(videoId, stamp());
      else removeFavorite.run(videoId);
    },

    listQueue({ shorts = 'include', streams = 'include' } = {}) {
      return queueRows.all({ isShort: SHORTS_FILTER[shorts], hideStreams: HIDE_STREAMS[streams] }).map(toVideo);
    },

    enqueue(videoId) {
      addQueued.run(videoId, stamp());
    },

    // Placing by neighbour rather than index keeps moves right when the page hides some of the queue, such as Shorts.
    // A `before` that is null or not queued moves the video to the end.
    moveInQueue(videoId, before) {
      tx(() => {
        addQueued.run(videoId, stamp());
        const order = queueOrder.all().map((r) => r.id).filter((id) => id !== videoId);
        const at = order.indexOf(before);
        order.splice(at === -1 ? order.length : at, 0, videoId);
        order.forEach((id, i) => setQueuePosition.run(i, id));
      });
    },

    unqueueVideo(videoId) {
      removeQueued.run(videoId);
    },

    markWatched(videoIds) {
      const now = stamp();
      tx(() => {
        for (const id of videoIds) addWatched.run({ id, now });
      });
    },

    markUnwatched(videoId) {
      removeWatched.run(videoId);
    },

    savePosition(videoId, seconds) {
      upsertPosition.run(videoId, seconds, stamp());
    },

    clearPosition(videoId) {
      removePosition.run(videoId);
    },

    // Runs once per database: returns false without calling `load` if it already ran or channels exist.
    seedChannels(load) {
      if (db.prepare('SELECT seeded FROM meta').get().seeded) return false;
      return tx(() => {
        const empty = !db.prepare('SELECT 1 FROM channels LIMIT 1').get();
        if (empty) {
          const { topics, channels, rules = [] } = load();
          const now = stamp();
          topics.forEach((t, i) => insertTopic.run(t.id, t.name, i, t.hidden ? 1 : 0));
          for (const c of channels) {
            insertChannel.run({ id: c.id, name: c.name, handle: c.handle ?? null, avatar: null, subscribed: c.subscribed === false ? 0 : 1, favorite: c.favorite ? 1 : 0, now });
            linkTopics(c.id, c.topics);
          }
          for (const r of rules) insertRule.run({ kind: r.kind, pattern: r.pattern, words: spacedWords(r.pattern), channelId: r.channelId, topicId: r.topicId });
        }
        db.exec('UPDATE meta SET seeded = 1');
        return empty;
      });
    },

    listChannels() {
      return channelRows.all().map((r) => ({
        id: r.id,
        name: r.name,
        handle: r.handle,
        avatar: r.avatar,
        topics: JSON.parse(r.topics),
        subscribed: r.subscribed === 1,
        favorite: r.favorite === 1,
        addedAt: r.addedAt,
      }));
    },

    listTopics,

    channelsMissingAvatar(limit) {
      return missingAvatar.all(limit).map((r) => r.id);
    },

    // avatar null records that the channel has no picture.
    setAvatars(avatars) {
      tx(() => {
        for (const { id, avatar } of avatars) setAvatar.run(avatar ?? '', id);
      });
    },

    subscribeChannel({ id, name, handle, avatar }, topicIds) {
      return tx(() => {
        const created = !channelExists.get(id);
        insertChannel.run({ id, name, handle: handle ?? null, avatar: avatar ?? null, subscribed: 1, favorite: 0, now: stamp() });
        linkTopics(id, topicIds);
        return { created };
      });
    },

    // `topics` replaces the set, keeping the order of links that stay, so exports diff cleanly.
    updateChannel(id, { subscribed, favorite, topics }) {
      return tx(() => {
        const row = channelSubscribed.get(id);
        if (!row) return null;
        if (subscribed !== undefined) setSubscribed.run(subscribed ? 1 : 0, id);
        if (favorite !== undefined) setChannelFavorite.run(favorite ? 1 : 0, id);
        if (topics !== undefined) {
          for (const { id: topicId } of linkedTopics.all(id)) if (!topics.includes(topicId)) deleteLink.run(id, topicId);
          linkTopics(id, topics);
        }
        return { wasSubscribed: row.subscribed === 1 };
      });
    },

    setTopicOnChannels(topicId, channelIds, linked) {
      return tx(() => {
        let changed = 0;
        for (const id of channelIds) changed += (linked ? insertLink : deleteLink).run(id, topicId).changes;
        return changed;
      });
    },

    deleteChannel(id) {
      return tx(() => {
        const removed = removeChannelRow.run(id).changes > 0;
        removeBackfill.run(id);
        return removed;
      });
    },

    createTopic(name) {
      const base = slugify(name);
      let id = base;
      for (let n = 2; topicExists.get(id); n++) id = `${base}-${n}`;
      insertTopic.run(id, name, null, 0);
      return listTopics().find((t) => t.id === id);
    },

    ensureTopic(id, name) {
      return insertTopic.run(id, name, null, 0).changes > 0;
    },

    updateTopic(id, { name, position, hidden }) {
      return tx(() => {
        if (!topicExists.get(id)) return false;
        if (name !== undefined) renameTopic.run(name, id);
        if (hidden !== undefined) setTopicHidden.run(hidden ? 1 : 0, id);
        if (position !== undefined) {
          const order = topicRows.all().map((t) => t.id).filter((t) => t !== id);
          order.splice(Math.min(position, order.length), 0, id);
          order.forEach((t, i) => setTopicPosition.run(i, t));
        }
        return true;
      });
    },

    deleteTopic(id) {
      return tx(() => {
        if (!removeTopicRow.run(id).changes) return false;
        removeVisit.run(topicGroup(id));
        return true;
      });
    },

    listRules,

    // A route rule needs both a channel and a topic. Returns the new rule.
    addRule({ kind, pattern, channelId = null, topicId = null }) {
      const { lastInsertRowid } = insertRule.run({ kind, pattern, words: spacedWords(pattern), channelId, topicId });
      return listRules().find((r) => r.id === Number(lastInsertRowid));
    },

    deleteRule(id) {
      return removeRule.run(id).changes > 0;
    },
  };
}
