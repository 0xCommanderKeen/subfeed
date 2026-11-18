// The sidebar's filter switches, in the order it shows them. No DOM here, so the tests import it directly.
// `key` names the switch in a filters object, `pref` is the stored preference and `initial` its default.
// `param` is the API query key with the values it sends when the switch is on and off.
export const FILTERS = [
  { key: 'hideShorts', pref: 'hideShorts', initial: true, label: 'Hide Shorts', title: 'Hide Shorts', param: { name: 'shorts', on: 'exclude', off: 'include' } },
  { key: 'hideStreams', pref: 'hideStreams', initial: false, label: 'Hide streams', title: 'Hide live streams, premieres and stream replays', param: { name: 'streams', on: 'exclude', off: 'include' } },
  { key: 'hideWatched', pref: 'hideWatched', initial: false, label: 'Hide watched', title: 'Hide videos marked watched', param: { name: 'watched', on: 'exclude', off: 'include' } },
  { key: 'showMuted', pref: 'showMuted', initial: false, label: 'Show muted', title: 'Show the videos your mute and route rules hide, marked muted', param: { name: 'muted', on: 'show', off: 'hide' } },
];

// The API query for `filters`, `{ hideShorts, ... }`. A switch the object leaves out counts as off.
export const filterParams = (filters) => Object.fromEntries(FILTERS.map(({ key, param }) => [param.name, filters[key] ? param.on : param.off]));
