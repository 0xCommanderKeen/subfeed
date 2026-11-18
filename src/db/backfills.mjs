export function backfills(db, tx, writeVideos) {
  const backfillRow = db.prepare('SELECT * FROM backfills WHERE channel_id = ?');
  // A done row has nothing left to resume, so the next run of its channel starts at the first page.
  const startBackfillRow = db.prepare(`
    INSERT INTO backfills (channel_id, state, owner, heartbeat_at, queued_at, started_at)
    VALUES (:channelId, :state, :owner, :now, :now, :startedAt)
    ON CONFLICT (channel_id) DO UPDATE SET
      state = excluded.state, owner = excluded.owner, heartbeat_at = excluded.heartbeat_at,
      queued_at = CASE WHEN excluded.state = 'queued' THEN excluded.queued_at ELSE queued_at END,
      started_at = excluded.started_at, error = NULL, finished_at = NULL,
      playlist = CASE WHEN state = 'done' THEN NULL ELSE playlist END,
      page_token = CASE WHEN state = 'done' THEN NULL ELSE page_token END,
      units = CASE WHEN state = 'done' THEN 0 ELSE units END,
      long_count = CASE WHEN state = 'done' THEN 0 ELSE long_count END,
      short_count = CASE WHEN state = 'done' THEN 0 ELSE short_count END
  `);
  const nextQueuedBackfill = db.prepare(`
    SELECT c.id, c.name FROM backfills b JOIN channels c ON c.id = b.channel_id AND c.subscribed = 1
    WHERE b.state = 'queued' ORDER BY b.queued_at, b.rowid LIMIT 1
  `);
  const requeueBackfills = db.prepare(`
    UPDATE backfills SET state = 'queued', owner = NULL
    WHERE state = 'running' AND (owner LIKE :ownerPrefix || '%' OR heartbeat_at < :staleBefore)
  `);
  const beatBackfill = db.prepare("UPDATE backfills SET heartbeat_at = :now WHERE channel_id = :channelId AND owner = :owner AND state = 'running'");
  const countBackfillUnit = db.prepare(`
    UPDATE backfills SET units = units + 1, heartbeat_at = :now WHERE channel_id = :channelId AND owner = :owner AND state = 'running'
  `);
  const backfillPage = db.prepare(`
    UPDATE backfills SET playlist = :playlist, page_token = :pageToken, long_count = long_count + :long,
      short_count = short_count + :short, heartbeat_at = :now
    WHERE channel_id = :channelId AND owner = :owner AND state = 'running'
  `);
  const finishBackfillRow = db.prepare(`
    UPDATE backfills SET state = :state, error = :error, finished_at = :now, heartbeat_at = NULL,
      playlist = CASE WHEN :state = 'done' THEN NULL ELSE playlist END,
      page_token = CASE WHEN :state = 'done' THEN NULL ELSE page_token END
    WHERE channel_id = :channelId AND owner = :owner AND state = 'running'
  `);
  const removeBackfill = db.prepare('DELETE FROM backfills WHERE channel_id = ?');

  const backfillView = (r) => r && {
    state: r.state,
    owner: r.owner,
    heartbeatAt: r.heartbeat_at,
    playlist: r.playlist,
    pageToken: r.page_token,
    units: r.units,
    long: r.long_count,
    short: r.short_count,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };

  // A row is held when another run is running it and has shown it is alive since staleBefore.
  const heldByOther = (row, owner, staleBefore) => row?.state === 'running' && row.owner !== owner && row.heartbeat_at >= staleBefore;

  return {
    backfill(channelId) {
      return backfillView(backfillRow.get(channelId));
    },

    // Queues the channel's backfill for the server unless a run holds it or it is queued already. A row that failed
    // keeps its place, so the next run continues there. Returns whether it queued.
    queueBackfill(channelId, { now, staleBefore }) {
      return tx(() => {
        const row = backfillRow.get(channelId);
        if (row?.state === 'queued' || heldByOther(row, null, staleBefore)) return false;
        startBackfillRow.run({ channelId, state: 'queued', owner: null, now, startedAt: null });
        return true;
      });
    },

    // Makes `owner` the run of the channel's backfill, unless another live run holds it. Returns the row, or null.
    claimBackfill(channelId, owner, { now, staleBefore }) {
      return tx(() => {
        if (heldByOther(backfillRow.get(channelId), owner, staleBefore)) return null;
        startBackfillRow.run({ channelId, state: 'running', owner, now, startedAt: now });
        return backfillView(backfillRow.get(channelId));
      });
    },

    nextQueuedBackfill() {
      return nextQueuedBackfill.get();
    },

    // The rows a run of `ownerPrefix` held when it stopped, and those whose run died, go back on the queue.
    requeueBackfills({ ownerPrefix, staleBefore }) {
      requeueBackfills.run({ ownerPrefix, staleBefore });
    },

    // beatBackfill, countBackfillUnit, storeBackfillPage and finishBackfill return false once `owner` no longer holds the
    // row: it was cancelled, or another run took it over.
    beatBackfill(channelId, owner, now) {
      return beatBackfill.run({ channelId, owner, now }).changes === 1;
    },

    countBackfillUnit(channelId, owner, now) {
      return countBackfillUnit.run({ channelId, owner, now }).changes === 1;
    },

    // Stores a page's videos and the place of the next page together, so a run that stops resumes after this page.
    storeBackfillPage(channelId, owner, { videos, playlist, pageToken, long, short, now }) {
      return tx(() => {
        if (backfillPage.run({ channelId, owner, playlist, pageToken, long, short, now }).changes !== 1) return false;
        writeVideos(videos);
        return true;
      });
    },

    finishBackfill(channelId, owner, { state, error = null, now }) {
      return finishBackfillRow.run({ channelId, owner, state, error, now }).changes === 1;
    },

    deleteBackfill(channelId) {
      removeBackfill.run(channelId);
    },
  };
}
