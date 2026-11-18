// What the in-page player decides. No DOM here, so the tests import it directly.
import { kindOf } from './kinds.js';

// A premiere or stream that has not started cannot play yet, so it still opens on YouTube.
export const playsHere = (v) => kindOf(v.kind).watchable;

// Middle-click and modifier clicks keep the browser's own open-in-a-tab behavior.
export const wantsTab = (e) => e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey;

// A video counts as watched once this much of it has played, so skipping the end screen still marks it.
const MOSTLY = 0.9;
export const mostlyPlayed = (v, seconds, length) => v.kind !== 'live' && length > 0 && seconds >= length * MOSTLY;

// IFrame API error codes for a video whose owner forbids playing it outside YouTube.
const EMBED_REFUSED = new Set([101, 150, 153]);
export const errorText = (code) => (EMBED_REFUSED.has(code)
  ? 'The channel does not allow this video to play outside YouTube.'
  : 'This video cannot play here.');

// Resuming in the first seconds is not worth a jump.
const RESUME_FROM = 5;

// The YouTube link resumes where the player stopped. Shorts links take no start time.
export function youtubeUrl(v, seconds = 0) {
  const t = Math.floor(seconds);
  if (v.isShort || t < RESUME_FROM) return v.url;
  const url = new URL(v.url);
  url.searchParams.set('t', `${t}s`);
  return url.href;
}

// Where the player resumes the video next time, in whole seconds, or null to forget the place. Shorts and live streams
// start over, and a video played to the watched point is done.
export function positionToSave(v, seconds, length) {
  const t = Math.floor(seconds);
  return v.isShort || v.kind === 'live' || t < RESUME_FROM || mostlyPlayed(v, seconds, length) ? null : t;
}

export function stepFrom(videos, from, step) {
  for (let i = from + step; i >= 0 && i < videos.length; i += step) if (playsHere(videos[i])) return i;
  return -1;
}
