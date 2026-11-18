import { VIDEO_ID } from './vocab.js';

export const YOUTUBE_HOST = /^(?:(?:www|m|music)\.)?youtube\.com$/i;
const VIDEO_PATHS = new Set(['shorts', 'live', 'embed', 'v']);

// Typed links often leave the scheme out.
export const withScheme = (s) => (/^https?:/i.test(s) ? s : `https://${s}`);

// Share sheets put the link in `url`, `text` or `title`, often after the video's title, so the first URL found wins.
export function parseShared(...parts) {
  const text = parts.filter(Boolean).join(' ');
  const link = text.match(/https?:\/\/\S+/i)?.[0];
  if (!link) {
    const handle = text.trim().match(/^@[\p{L}\p{N}_.-]{3,30}$/u)?.[0];
    return handle ? { kind: 'channel', input: handle } : null;
  }
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const [first, second] = url.pathname.split('/').filter(Boolean);
  const video = (id, isShort = false) => (VIDEO_ID.test(id ?? '') ? { kind: 'video', id, isShort } : null);
  if (/^(?:www\.)?youtu\.be$/i.test(url.hostname)) return video(first);
  if (!YOUTUBE_HOST.test(url.hostname)) return null;
  if (first === 'watch') return video(url.searchParams.get('v'));
  if (VIDEO_PATHS.has(first)) return video(second, first === 'shorts');
  if (first?.startsWith('@') || first === 'channel') return { kind: 'channel', input: `https://www.youtube.com${url.pathname}` };
  return null;
}
