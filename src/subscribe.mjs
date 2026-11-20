import { refreshFeeds } from './refresh.mjs';
import { resolveChannel } from './resolve.mjs';

// The channel lookup failed, as opposed to YouTube having no such channel.
export class LookupError extends Error {}

// A known channel needs no YouTube lookup. `topicIds` must name existing topics.
export async function subscribeChannel(db, ref, topicIds, { api = null, fetchPage, fetchFeeds, onChannel }) {
  let channel = db
    .listChannels()
    .find((c) => (ref.kind === 'id' ? c.id === ref.id : c.handle?.toLowerCase() === ref.handle.toLowerCase()));
  if (!channel) {
    try {
      channel = await resolveChannel(ref, { api, fetchImpl: fetchPage });
    } catch (err) {
      throw new LookupError(err.message, { cause: err });
    }
  }
  if (!channel) return null;
  const { created } = db.subscribeChannel(channel, topicIds);
  await refreshFeeds(db, [channel.id], { fetchFeeds, onChannel });
  return { created, channel };
}
