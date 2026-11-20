import { DETAIL_PARTS, bestThumbnail, videoDetails } from './backfill.mjs';
import { decodeEntities, fetchText } from './feed.mjs';
import { YOUTUBE_HOST, withScheme } from '../public/share-link.js';
import { CHANNEL_ID } from '../public/vocab.js';
import { ApiError, MAX_PER_CALL } from './youtube-api.mjs';

// YouTube handles are 3 to 30 letters, digits, underscores, hyphens and periods, in any script.
const HANDLE = /^@?([\p{L}\p{N}_.-]{3,30})$/u;
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en',
};

export const INPUT_HELP = 'Enter @handle, handle, https://www.youtube.com/@handle or https://www.youtube.com/channel/UC…';

export function parseChannelInput(raw) {
  const s = String(raw ?? '').trim();
  if (CHANNEL_ID.test(s)) return { kind: 'id', id: s };
  let candidate = s;
  const url = URL.parse(withScheme(s));
  if (url && YOUTUBE_HOST.test(url.hostname)) {
    let segments;
    try {
      segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return null;
    }
    if (segments[0] === 'channel') return CHANNEL_ID.test(segments[1]) ? { kind: 'id', id: segments[1] } : null;
    if (!segments[0]?.startsWith('@')) return null;
    candidate = segments[0];
  }
  const m = candidate.match(HANDLE);
  return m ? { kind: 'handle', handle: `@${m[1]}` } : null;
}

// Medium is 240 px, enough for the largest avatar on the page.
const avatarFromThumbnails = (thumbnails = {}) => (thumbnails.medium ?? thumbnails.high ?? thumbnails.default)?.url ?? null;

// A channels.list item. Its customUrl is the handle, with or without the @.
function channelFromApiItem({ id, snippet = {} }) {
  const { title, customUrl, thumbnails } = snippet;
  return { id, name: title ?? id, handle: customUrl ? `@${customUrl.replace(/^@/, '')}` : null, avatar: avatarFromThumbnails(thumbnails) };
}

export function parseApiChannel(body, ref) {
  const item = body?.items?.[0];
  if (!item) return null;
  return { ...channelFromApiItem(item), ...(ref.kind === 'handle' && { handle: ref.handle }) };
}

// Ids YouTube does not return are absent from the map.
export async function lookupChannels(ids, api) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += MAX_PER_CALL) {
    const batch = ids.slice(i, i + MAX_PER_CALL);
    const body = await api('channels', { part: 'snippet,statistics', id: batch.join(','), maxResults: String(MAX_PER_CALL) });
    for (const item of body.items ?? []) {
      const videoCount = Number(item.statistics?.videoCount);
      found.set(item.id, { ...channelFromApiItem(item), description: item.snippet?.description ?? '', videoCount: Number.isFinite(videoCount) ? videoCount : null });
    }
  }
  return found;
}

export function parseChannelPage(html, ref) {
  const id = html.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
  if (!id) return null;
  const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  const vanity = html.match(/"vanityChannelUrl":"https?:\/\/www\.youtube\.com\/(@[^"]+)"/)?.[1];
  const handle = ref.kind === 'handle' ? ref.handle : vanity ? decodeURIComponent(vanity) : null;
  // og:image is 900 px; the size option asks for 240 px, as from the API.
  const image = html.match(/<meta property="og:image" content="([^"]*)"/)?.[1];
  const avatar = image ? decodeEntities(image).replace(/=s\d+-/, '=s240-') : null;
  return { id, name: title ? decodeEntities(title) : (handle ?? id).replace(/^@/, ''), handle, avatar };
}

export function fetchChannelPage(ref, fetchImpl) {
  const url = `https://www.youtube.com/${ref.kind === 'handle' ? `@${encodeURIComponent(ref.handle.slice(1))}` : `channel/${ref.id}`}`;
  return fetchText(url, { fetchImpl, headers: PAGE_HEADERS });
}

// `fromApi()` when there is an API key, or `scrape()` of the YouTube page when there is none or the API call fails.
async function apiOrScrape(fromApi, scrape) {
  if (fromApi) {
    try {
      return await fromApi();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      console.warn(`Data API call failed (${err.message}); reading the page instead`);
    }
  }
  return scrape();
}

export function resolveChannel(ref, { api = null, fetchImpl }) {
  return apiOrScrape(
    api && (async () => parseApiChannel(await api('channels', { part: 'snippet', ...(ref.kind === 'handle' ? { forHandle: ref.handle } : { id: ref.id }) }), ref)),
    async () => {
      const html = await fetchChannelPage(ref, fetchImpl);
      return html === null ? null : parseChannelPage(html, ref);
    },
  );
}

// A shared video, as stored in `videos`, with its channel's name: { id, channelId, channelName, title, published,
// thumbnail, isShort, views, durationS, kind }. Neither source says whether a video is a Short, so the caller does.
export function parseApiVideo(body, isShort) {
  const item = body?.items?.[0];
  if (!item) return null;
  const { channelId, channelTitle, title, publishedAt, thumbnails } = item.snippet;
  return {
    id: item.id,
    channelId,
    channelName: channelTitle,
    title,
    published: new Date(publishedAt).toISOString(),
    thumbnail: bestThumbnail(thumbnails),
    isShort,
    ...videoDetails(item, isShort),
  };
}

const jsonString = (html, key) => {
  const literal = html.match(new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`))?.[1];
  return literal === undefined ? null : JSON.parse(literal);
};

// Watch page HTML -> video, or null when the page shows no video. The page tells no kind, so a refresh with an
// API key fills it in. Live and upcoming videos report a length of 0, which is not their length.
export function parseWatchPage(html, id, isShort) {
  const channelId = jsonString(html, 'externalChannelId');
  const published = html.match(/<meta itemprop="datePublished" content="([^"]+)"/)?.[1] ?? jsonString(html, 'publishDate');
  if (!CHANNEL_ID.test(channelId) || !published) return null;
  const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  const length = Number(jsonString(html, 'lengthSeconds'));
  const views = jsonString(html, 'viewCount');
  return {
    id,
    channelId,
    channelName: jsonString(html, 'ownerChannelName') ?? channelId,
    title: title ? decodeEntities(title) : id,
    published: new Date(published).toISOString(),
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isShort,
    views: views === null ? null : Number(views),
    durationS: length > 0 ? length : null,
    kind: null,
  };
}

// Looks a video up with the Data API when `api` is given (1 unit) and on its watch page otherwise, or when the API
// call fails. Returns null when YouTube has no such video.
export function resolveVideo(id, isShort, { api = null, fetchImpl }) {
  return apiOrScrape(
    api && (async () => parseApiVideo(await api('videos', { part: DETAIL_PARTS, id }), isShort)),
    async () => {
      const html = await fetchText(`https://www.youtube.com/watch?v=${id}`, { fetchImpl, headers: PAGE_HEADERS });
      return html === null ? null : parseWatchPage(html, id, isShort);
    },
  );
}
