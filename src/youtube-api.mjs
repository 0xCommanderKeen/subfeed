const API_BASE = 'https://www.googleapis.com/youtube/v3/';

// channels.list and videos.list take up to 50 ids per call; playlistItems.list returns up to 50 items per page.
export const MAX_PER_CALL = 50;

export class ApiError extends Error {
  constructor(status, reason, message) {
    super(`HTTP ${status} ${reason}: ${message}`);
    this.status = status;
    this.reason = reason;
  }
}

export function fetchApi(key, fetchImpl = fetch) {
  return async (endpoint, params) => {
    const url = `${API_BASE}${endpoint}?${new URLSearchParams({ ...params, key })}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    const body = res.ok ? await res.json() : await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.error?.errors?.[0]?.reason ?? 'error', body.error?.message ?? '');
    return body;
  };
}

// Every Data API call this project makes (channels, playlistItems, subscriptions, videos .list) costs 1 quota unit,
// whatever parts it asks for. `onCall()` runs once per call, for example to record daily usage.
export function meteredApi(api, { onCall = () => {} } = {}) {
  const meter = {
    unitsSinceStart: 0,
    api: (endpoint, params) => {
      meter.unitsSinceStart++;
      onCall();
      return api(endpoint, params);
    },
  };
  return meter;
}

// The quota resets at midnight Pacific time, so usage is counted per Pacific day (YYYY-MM-DD).
const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
export const pacificDay = (date) => PACIFIC_DAY.format(date);

// Counts every call of `api` toward the quota of the day in the database.
export const dbMeter = (db, api) => meteredApi(api, { onCall: () => db.addApiUnits(pacificDay(db.now()), 1) });

export const unitsToday = (db) => db.apiUnitsOn(pacificDay(db.now()));

// The default Data API quota is 10,000 units per Pacific day. Backfills stop short of it so refreshes keep
// RESERVE_UNITS for their duration and avatar lookups.
export const DAILY_QUOTA = 10_000;
export const RESERVE_UNITS = 1_000;
export const BACKFILL_LIMIT = DAILY_QUOTA - RESERVE_UNITS;

// The next midnight Pacific after `date`, plus a minute so a clock a little ahead of Google's does not resume
// into the old day. Midnight is never inside a daylight saving switch, so it is 07:00 or 08:00 UTC.
export function quotaResetAfter(date) {
  const [y, m, d] = pacificDay(date).split('-').map(Number);
  const midnight = [7, 8].map((h) => new Date(Date.UTC(y, m - 1, d + 1, h))).find((t) => pacificDay(t) !== pacificDay(date));
  return new Date(midnight.getTime() + 60_000);
}

// Wraps a backfill's `api` so that it pauses instead of failing near the quota: before a call when `unitsToday()`
// has reached BACKFILL_LIMIT, and after YouTube answers quotaExceeded, it calls `onPause(resumesAt)`, waits with
// `wait(ms)`, calls `onResume()` and tries the same call again. A backfill so resumes where it stopped.
export function quotaPausingApi(api, { unitsToday, wait, now, onPause = () => {}, onResume = () => {} }) {
  return async (endpoint, params) => {
    for (;;) {
      if (unitsToday() < BACKFILL_LIMIT) {
        try {
          return await api(endpoint, params);
        } catch (err) {
          if (!(err instanceof ApiError && err.reason === 'quotaExceeded')) throw err;
        }
      }
      const resumesAt = quotaResetAfter(now());
      onPause(resumesAt);
      await wait(resumesAt - now());
      onResume();
    }
  };
}
