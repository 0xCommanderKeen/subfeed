import { VIDEO_ID } from '../public/vocab.js';

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e) => {
    if (e[0] !== '#') return NAMED_ENTITIES[e] ?? match;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

// Each channel has one uploads playlist per kind (videos, Shorts, live streams); its id is the channel id with
// "UC" swapped for the prefix. The kind a video came from decides isShort.
export const PLAYLIST_KINDS = [
  { prefix: 'UULF', isShort: false },
  { prefix: 'UUSH', isShort: true },
  { prefix: 'UULV', isShort: false },
];

export const playlistId = (channelId, kind) => kind.prefix + channelId.slice(2);

const playlistFeedUrl = (playlistId) => `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;

export const videoUrl = (id, isShort) =>
  isShort ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;

function entryToVideo(entry, channelId, isShort) {
  const pick = (re) => entry.match(re)?.[1];
  const id = pick(/<yt:videoId>([^<]+)<\/yt:videoId>/);
  const title = pick(/<title>([^<]*)<\/title>/);
  const published = new Date(pick(/<published>([^<]+)<\/published>/) ?? NaN);
  if (!VIDEO_ID.test(id ?? '') || title === undefined || Number.isNaN(published.getTime())) return null;
  const thumbnail = pick(/<media:thumbnail url="([^"]+)"/);
  const views = pick(/<media:statistics views="(\d+)"/);
  const description = pick(/<media:description>([^<]*)<\/media:description>/);
  return {
    id,
    channelId,
    title: decodeEntities(title),
    description: description === undefined ? null : decodeEntities(description),
    published: published.toISOString(),
    thumbnail: thumbnail === undefined ? null : decodeEntities(thumbnail),
    isShort,
    views: views === undefined ? null : Number(views),
    durationS: null,
  };
}

function parseFeed(xml, channelId, isShort) {
  const parsed = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => entryToVideo(entry, channelId, isShort));
  const videos = parsed.filter(Boolean);
  return { videos, skipped: parsed.length - videos.length };
}

// A refresh fails a channel only when the second try fails too. One timed-out request is not news: a slow YouTube answer,
// or a synchronous SQLite call that stalls the event loop past the timeout, aborts whatever was in flight.
async function twice(request) {
  try {
    return await request();
  } catch {
    return request();
  }
}

const channelFeedUrl = (channelId) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

// The body of `url`, or null when it answers 404.
export async function fetchText(url, { fetchImpl, timeoutMs = 15_000, headers }) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// A playlist that does not exist yet (a channel with no Shorts) answers 404: treat it as empty.
async function fetchPlaylist(channelId, kind, timeoutMs, fetchImpl) {
  const xml = await fetchText(playlistFeedUrl(playlistId(channelId, kind)), { fetchImpl, timeoutMs });
  return xml === null ? { missing: true, videos: [], skipped: 0 } : { missing: false, ...parseFeed(xml, channelId, kind.isShort) };
}

// With neither uploads playlist, the channel feed tells an empty channel (200, no entries) from one that does not exist.
const channelExists = async (channelId, timeoutMs, fetchImpl) => (await fetchText(channelFeedUrl(channelId), { fetchImpl, timeoutMs })) !== null;

// `videos` holds whatever loaded, also when `error` is set. A channel with no public videos has no error.
export async function fetchChannelFeeds(channelId, timeoutMs = 10_000, fetchImpl = fetch) {
  const settled = await Promise.allSettled(PLAYLIST_KINDS.map((kind) => twice(() => fetchPlaylist(channelId, kind, timeoutMs, fetchImpl))));
  const fetched = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failure = settled.find((r) => r.status === 'rejected');
  let error = null;
  const skipped = fetched.reduce((n, r) => n + r.skipped, 0);
  if (failure) error = failure.reason.message;
  else if (skipped) error = `skipped ${skipped} malformed feed ${skipped === 1 ? 'entry' : 'entries'}`;
  else if (fetched.every((r) => r.missing)) {
    try {
      if (!(await twice(() => channelExists(channelId, timeoutMs, fetchImpl)))) error = 'channel not found (HTTP 404)';
    } catch (err) {
      error = err.message;
    }
  }
  return { videos: fetched.flatMap((r) => r.videos), error };
}
