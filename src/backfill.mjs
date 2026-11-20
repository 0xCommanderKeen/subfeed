import { randomUUID } from 'node:crypto';
import { PLAYLIST_KINDS, playlistId } from './feed.mjs';
import { STATS_MAX_AGE_MS, hotSince } from './hot.mjs';
import { DAY, isoBefore } from '../public/groups.js';
import { KINDS } from '../public/kinds.js';
import { ApiError, MAX_PER_CALL } from './youtube-api.mjs';

export function parseDuration(iso) {
  const m = iso?.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [d, h, min, s] = m.slice(1).map((x) => Number(x ?? 0));
  return ((d * 24 + h) * 60 + min) * 60 + s;
}

export const bestThumbnail = (thumbnails = {}) =>
  (thumbnails.high ?? thumbnails.medium ?? thumbnails.default ?? Object.values(thumbnails)[0])?.url ?? null;

// Private and deleted entries stay in the uploads playlist but carry no videoPublishedAt.
function playlistItemsToVideos(items, channelId, isShort) {
  return items
    .filter((item) => item.contentDetails?.videoPublishedAt)
    .map((item) => ({
      id: item.contentDetails.videoId,
      channelId,
      title: item.snippet.title,
      description: item.snippet.description ?? null,
      published: new Date(item.contentDetails.videoPublishedAt).toISOString(),
      thumbnail: bestThumbnail(item.snippet.thumbnails),
      isShort,
      views: null,
      durationS: null,
    }));
}

// videos.list costs 1 unit for up to 50 ids whatever the parts, so every lookup asks for all of them.
export const DETAIL_PARTS = 'contentDetails,statistics,liveStreamingDetails,snippet';
// A video YouTube left out is asked for again until it is this old.
const UNAVAILABLE_RETRY_MS = 7 * DAY;

// Live and upcoming videos report P0D, which is not their length: their duration stays unknown.
export function videoDetails(item, isShort) {
  if (!item) return { durationS: null, views: null, kind: 'unavailable' };
  const views = item.statistics?.viewCount;
  const live = item.snippet?.liveBroadcastContent;
  let kind;
  if (live === 'upcoming' || live === 'live') kind = live;
  else if (item.liveStreamingDetails?.actualStartTime) kind = 'stream_replay';
  else kind = isShort ? 'short' : 'video';
  const durationS = KINDS[kind].needsDetails ? null : parseDuration(item.contentDetails?.duration);
  return { durationS, views: views === undefined ? null : Number(views), kind };
}

// An answer without items says nothing about the videos, so it must not mark them unavailable.
async function listVideos(api, part, ids) {
  const body = await api('videos', { part, id: ids.join(','), maxResults: String(MAX_PER_CALL) });
  if (!Array.isArray(body.items)) throw new ApiError(200, 'noItems', 'videos.list answered without items');
  return new Map(body.items.map((item) => [item.id, item]));
}

const fetchDetails = (api, ids) => listVideos(api, DETAIL_PARTS, ids);

const withDetails = (videos, items) => videos.map((v) => ({ ...v, ...videoDetails(items.get(v.id), v.isShort) }));

// Batches already stored stay stored if a later call fails.
export async function fillMissingDetails({ db, api, maxCalls }) {
  const now = db.now().toISOString();
  const missing = db.videosMissingDetails({
    unavailableSince: isoBefore(now, UNAVAILABLE_RETRY_MS),
    limit: maxCalls * MAX_PER_CALL,
  });
  for (let i = 0; i < missing.length; i += MAX_PER_CALL) {
    const batch = missing.slice(i, i + MAX_PER_CALL);
    const items = await fetchDetails(api, batch.map((v) => v.id));
    db.applyDetails(withDetails(batch, items));
  }
  return missing.length;
}

// A video the API leaves out keeps its count until the next round.
export async function refreshViewCounts({ db, api, maxCalls }) {
  const now = db.now().toISOString();
  const stale = db.videosNeedingStats({
    since: hotSince(now),
    staleBefore: isoBefore(now, STATS_MAX_AGE_MS),
    limit: maxCalls * MAX_PER_CALL,
  });
  for (let i = 0; i < stale.length; i += MAX_PER_CALL) {
    const batch = stale.slice(i, i + MAX_PER_CALL);
    const items = await listVideos(api, 'statistics', batch);
    db.applyStats(batch.map((id) => {
      const views = items.get(id)?.statistics?.viewCount;
      return { id, views: views === undefined ? null : Number(views) };
    }));
  }
  return stale.length;
}

// A run raises its row's heartbeat this often, even while it waits for the quota. A running row whose heartbeat is
// older than BACKFILL_STALE_MS belongs to a run that died, and another run may take it over.
const BACKFILL_HEARTBEAT_MS = 60_000;
export const BACKFILL_STALE_MS = 5 * 60_000;

export class BackfillHeld extends Error {}

// Reads the channel's uploads playlists from the page its row names, and stores each page with the place of the next
// one, so a run that fails or stops is continued by the next run, not started again. `owner` names this run in the
// row; the claim fails with BackfillHeld while another live run holds the channel. A video that already has a
// duration is left out of videos.list. A run stopped through `signal` leaves its row running, for the next run to take
// over. Returns the long videos and Shorts counted over the whole backfill.
export async function backfillChannel(channel, { api, db, owner = randomUUID(), signal }) {
  const { now } = db;
  const at = () => now().toISOString();
  const staleBefore = isoBefore(now(), BACKFILL_STALE_MS);
  const claimed = db.claimBackfill(channel.id, owner, { now: at(), staleBefore });
  if (!claimed) throw new BackfillHeld(`another run is backfilling ${channel.name}`);
  const lost = () => new Error(`the backfill of ${channel.name} was cancelled or taken over`);
  const call = (endpoint, params) => {
    if (!db.countBackfillUnit(channel.id, owner, at())) throw lost();
    return api(endpoint, params);
  };
  const heartbeat = setInterval(() => db.beatBackfill(channel.id, owner, at()), BACKFILL_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const first = Math.max(0, PLAYLIST_KINDS.findIndex((kind) => playlistId(channel.id, kind) === claimed.playlist));
    for (let i = first; i < PLAYLIST_KINDS.length; i++) {
      const kind = PLAYLIST_KINDS[i];
      const playlist = playlistId(channel.id, kind);
      const following = PLAYLIST_KINDS[i + 1] ? playlistId(channel.id, PLAYLIST_KINDS[i + 1]) : null;
      let pageToken = i === first ? claimed.pageToken : null;
      do {
        let page;
        try {
          page = await call('playlistItems', {
            part: 'contentDetails,snippet',
            maxResults: String(MAX_PER_CALL),
            playlistId: playlist,
            ...(pageToken && { pageToken }),
          });
        } catch (err) {
          // A channel with no Shorts (or no long videos) has no such playlist.
          if (err instanceof ApiError && err.status === 404) break;
          throw err;
        }
        // Read as an empty last page, it would mark the channel done with the rest of the playlist unread.
        if (!Array.isArray(page.items)) throw new ApiError(200, 'noItems', 'playlistItems.list answered without items');
        const videos = playlistItemsToVideos(page.items, channel.id, kind.isShort);
        const known = db.videosWithDuration(videos.map((v) => v.id));
        const ask = videos.filter((v) => !known.has(v.id));
        const details = ask.length ? withDetails(ask, await fetchDetails(call, ask.map((v) => v.id))) : [];
        pageToken = page.nextPageToken;
        const stored = db.storeBackfillPage(channel.id, owner, {
          videos: [...videos.filter((v) => known.has(v.id)), ...details],
          ...(pageToken ? { playlist, pageToken } : { playlist: following, pageToken: null }),
          long: kind.isShort ? 0 : videos.length,
          short: kind.isShort ? videos.length : 0,
          now: at(),
        });
        if (!stored) throw lost();
      } while (pageToken);
    }
    if (!db.finishBackfill(channel.id, owner, { state: 'done', now: at() })) throw lost();
    const { long, short } = db.backfill(channel.id);
    return { long, short };
  } catch (err) {
    if (!signal?.aborted) db.finishBackfill(channel.id, owner, { state: 'error', error: err.message, now: at() });
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}
