// How long since each channel last uploaded, for the Manage page's Inactive view.
const DAY_MS = 86_400_000;

export const INACTIVE_PERIODS = [
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
  { days: 730, label: '2 years' },
];
export const DEFAULT_INACTIVE_DAYS = 180;

export function lastUpload(channel) {
  const times = Object.values(channel.latest).filter(Boolean);
  return times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
}

export function inactiveChannels(channels, days, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  return channels
    .filter((c) => c.subscribed)
    .map((c) => [c, lastUpload(c)])
    .filter(([, last]) => last === null || last < cutoff)
    .sort(([a, x], [b, y]) => (x ?? '').localeCompare(y ?? '') || a.name.localeCompare(b.name))
    .map(([c]) => c);
}

export function lastUploadText(channel, now = new Date()) {
  const last = lastUpload(channel);
  if (!last) return 'No uploads stored';
  const days = Math.floor((now - new Date(last)) / DAY_MS);
  const months = Math.floor(days / 30.44);
  const ago = days < 1 ? 'today'
    : days < 60 ? `${days} day${days === 1 ? '' : 's'} ago`
    : months < 24 ? `${months} months ago`
    : `${Math.floor(months / 12)} years ago`;
  return `Last upload ${ago}`;
}

function matchesFilter(channel, filter) {
  const needle = filter.toLowerCase();
  return !needle || channel.name.toLowerCase().includes(needle) || channel.handle?.toLowerCase().includes(needle);
}

export function shownChannels(channels, { view, filter, days }, now = new Date()) {
  const matching = channels.filter((c) => matchesFilter(c, filter));
  return view === 'inactive' ? inactiveChannels(matching, days, now) : matching;
}

// Bulk actions act on these only, so a tick hidden by the filter, view or period does nothing.
export function tickedChannels(channels, selected, options, now = new Date()) {
  return shownChannels(channels, options, now).filter((c) => c.subscribed && selected.has(c.id));
}
