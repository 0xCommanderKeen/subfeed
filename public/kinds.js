// What each video kind allows, for the server's SQL and the page's checks alike.
// A kind goes NULL -> upcoming -> live -> stream_replay or video; short and unavailable are end states too.
// NULL means not looked up yet (no API key, or not reached yet).
//   needsDetails: the length is not known yet, so each refresh looks the video up again.
//   isStream: a stream or premiere that is scheduled or live now, which Hide streams leaves out. An ended one
//     (stream_replay) is a normal video, because the API cannot tell an aired premiere from a stream replay.
//   announceable: a new upload of this kind gets a notification.
//   watchable: opening the video marks it watched.
export const KINDS = {
  video: { needsDetails: false, isStream: false, announceable: true, watchable: true },
  short: { needsDetails: false, isStream: false, announceable: false, watchable: true },
  upcoming: { needsDetails: true, isStream: true, announceable: false, watchable: false },
  live: { needsDetails: true, isStream: true, announceable: true, watchable: true },
  stream_replay: { needsDetails: false, isStream: false, announceable: true, watchable: true },
  unavailable: { needsDetails: false, isStream: false, announceable: false, watchable: true },
};
// Without an API key nothing can be told apart, so an unknown kind is treated as a regular video still to look up.
const UNKNOWN = { needsDetails: true, isStream: false, announceable: true, watchable: true };

export const kindOf = (kind) => KINDS[kind] ?? UNKNOWN;

// SQL condition, true when `column` holds a kind with `flag`, counting NULL as an unknown kind.
export function kindSql(flag, column = 'v.kind') {
  const list = Object.keys(KINDS).filter((k) => KINDS[k][flag]).map((k) => `'${k}'`).join(', ');
  return UNKNOWN[flag] ? `(${column} IS NULL OR ${column} IN (${list}))` : `coalesce(${column} IN (${list}), 0)`;
}
