import { DAY, HOUR, isoBefore } from '../public/groups.js';

// Hot ranks the videos of the last 14 days by views per hour since publish. A video younger than an hour counts as an
// hour old, so a few early views do not put it on top. RATE_SQL and viewsPerHour must compute the same number.
const HOT_WINDOW_MS = 14 * DAY;
// View counts in the window are looked up again once they are this old, so about four times a day.
export const STATS_MAX_AGE_MS = 6 * HOUR;
// Hot and the flames hide once a count in the window is older than this, when the stats refresh keeps failing
// (quota used up, revoked key, network) or has not run yet.
export const STATS_STALE_MS = 2 * STATS_MAX_AGE_MS;
export const RATE_SQL = 'v.views / max((julianday(:now) - julianday(v.published)) * 24, 1.0)';
// A flame needs at least this many other videos of the same channel and format in the window to compare with,
// and a rate this many times their average.
const MIN_OTHERS = 3;
const FLAME_RATIO = 3;

export const hotSince = (now) => isoBefore(now, HOT_WINDOW_MS);

export const hotStaleBefore = (now) => isoBefore(now, STATS_STALE_MS);

export const viewsPerHour = (views, published, now) => views / Math.max((Date.parse(now) - Date.parse(published)) / HOUR, 1);

// `usual` is { n, total } over the rates of the channel's videos in the window of the same format (long or Short),
// this video included. Returns the video with `viewsPerHour`, null outside the window, and `flame`.
export function withVelocity(v, usual, now) {
  const inWindow = v.views !== null && v.published <= now && v.published >= hotSince(now) && v.kind !== 'upcoming';
  if (!inWindow) return { ...v, viewsPerHour: null, flame: false };
  const rate = viewsPerHour(v.views, v.published, now);
  const others = usual ? usual.n - 1 : 0;
  const flame = others >= MIN_OTHERS && rate > 0 && rate >= (FLAME_RATIO * (usual.total - rate)) / others;
  return { ...v, viewsPerHour: rate, flame };
}
