// Every feed at once timed out on a small home server during the startup refresh at 487 channels.
const REFRESH_CONCURRENCY = 16;

// A channel whose fetch or write throws is reported to `onChannel` and the others go on, so the refresh always finishes.
// A channel's first fetch, in a new database or right after the channel is added, has no new uploads: only
// channels that had videos before this call report the ids they stored for the first time. Those ids are marked to be
// announced when `announce(channelId)` is true when they are stored.
//
// Channels are fetched `concurrency` at a time, and each batch is written only once all of its fetches have finished.
// A write is synchronous: on a cold database on a spinning disk one channel's write took up to 2.7 s, and fetches in
// flight meanwhile ran out their timeout though YouTube had answered.
export async function refreshFeeds(db, channelIds, { fetchFeeds, onChannel = () => {}, announce = () => false, concurrency = REFRESH_CONCURRENCY }) {
  const channelsWithVideos = db.channelsWithVideos();
  const uploads = [];
  for (let start = 0; start < channelIds.length; start += concurrency) {
    const batch = channelIds.slice(start, start + concurrency);
    const fetched = await Promise.allSettled(batch.map((id) => fetchFeeds(id)));
    batch.forEach((id, i) => {
      try {
        if (fetched[i].status === 'rejected') throw fetched[i].reason;
        const { videos, error } = fetched[i].value;
        const hadVideos = channelsWithVideos.has(id);
        const { insertedIds } = db.upsertVideos(videos, { announce: hadVideos && announce(id) });
        onChannel(id, error);
        if (hadVideos) uploads.push(...insertedIds);
      } catch (err) {
        onChannel(id, err.message);
      }
    });
  }
  return uploads;
}
