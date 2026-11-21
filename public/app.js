import { api, avatar, el, failed, fill, finePointer, icon, prefs, registerServiceWorker, segmented, starButton, toast, youtubeChannelUrl } from './dom.js';
import { DAY, bucketOf, buildGroups, defaultBaseline, dropsChannel, groupsMarkedSeen, latestVisible as latestOf, ruleHides, ruledTallies, setMark, shownTallies, tallySets, visibleCount as countOf } from './groups.js';
import { backfilling, stopBackfillQuestion } from './activity.js';
import { filterParams } from './filters.js';
import { pager, unknownChannelIds } from './pager.js';
import { hashOf, routeOf } from './route.js';
import { kindOf } from './kinds.js';
import { playsHere, wantsTab } from './playback.js';
import { openPlayer } from './player.js';
import { SHORTCUTS, VIDEO_ITEM, shortcutAction, stepIndex } from './shortcuts.js';
import { mountNav } from './sidebar.js';
import { loadingMore, skeletonGrid, skeletonPage, skeletonQueue, skeletonShelves } from './skeleton.js';
import { sortable } from './sortable.js';
import { WORD, compact, fold, formatAge, formatDuration, plural, whole, wordsOf } from './vocab.js';

const PER_SHELF = 12;
const SHELF_PAGE = 20;
const PAGE = 60;
// Videos with an unknown duration appear only with `any`.
const LENGTHS = {
  any: { label: 'Any', title: 'Any length' },
  short: { label: '<15m', title: 'Under 15 minutes' },
  medium: { label: '15–45m', title: '15 to 45 minutes' },
  long: { label: '45m+', title: 'Over 45 minutes' },
};
// The order of the Feed view. Hot needs fresh view counts, so the server offers it only with an API key.
const SORTS = {
  newest: { label: 'Newest', title: 'Newest first' },
  hot: { label: 'Hot', title: 'Most views per hour since publish, last 14 days' },
};
// How the Watch Later page lists the queue. Only the user's own order can be changed by moving rows.
const QUEUE_ORDERS = {
  queue: { label: 'Queue', title: 'Your order: move rows to change it', lede: 'in your order' },
  newest: { label: 'Newest added', title: 'Last added first', lede: 'last added first' },
  oldest: { label: 'Oldest added', title: 'First added first', lede: 'first added first' },
};
const HOT_SECTION = { key: 'hot', label: 'Hot · last 14 days' };

const state = {
  meta: null,
  channelsById: new Map(),
  groups: [],
  route: null, // { group, channelId, q }; q is the search text or null
  views: prefs.get('views', {}), // groupId -> view id
  length: Object.hasOwn(LENGTHS, prefs.get('length')) ? prefs.get('length') : 'any',
  sort: Object.hasOwn(SORTS, prefs.get('sort')) ? prefs.get('sort') : 'newest',
  queueOrder: Object.hasOwn(QUEUE_ORDERS, prefs.get('queueOrder')) ? prefs.get('queueOrder') : 'queue',
  // Bumped on every render, so responses for an earlier screen are dropped.
  generation: 0,
};

const $ = (id) => document.getElementById(id);
const main = $('main');
const isCurrentRender = (generation) => generation === state.generation;
// Aborted by the next render, for the requests of the one before it.
let renderAbort = new AbortController();

const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const monthName = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const age = (iso) => `${formatAge(iso)} ago`;

function period(iso) {
  const d = new Date(iso);
  const today = new Date().setHours(0, 0, 0, 0);
  const days = Math.round((today - d.setHours(0, 0, 0, 0)) / DAY);
  if (days <= 0) return { key: 'today', label: 'Today' };
  if (days === 1) return { key: 'yesterday', label: 'Yesterday' };
  if (days < 7) return { key: 'week', label: 'This week' };
  if (days < 14) return { key: 'last-week', label: 'Last week' };
  return month(iso);
}
function month(iso) {
  const d = new Date(iso);
  return { key: `${d.getFullYear()}-${d.getMonth()}`, label: monthName.format(d) };
}

const nav = mountNav({
  nav: $('nav'),
  opener: $('nav-open'),
  backdrop: $('nav-backdrop'),
  onPick: (group) => openGroup(group),
  onFilterChange: render,
  onRefresh: () => load(true),
});
const { filters } = nav;
// The channel's tallies in the group on screen, under its rules unless Show muted is on.
const ruled = (c) => ruledTallies(c, state.route.group, filters.showMuted);
const tallies = (c) => shownTallies(ruled(c), filters.hideWatched);
const visibleCount = (c) => countOf(tallies(c).counts, filters.hideShorts, filters.hideStreams);
const latestVisible = (c) => latestOf(tallies(c), filters.hideShorts, filters.hideStreams);

const setVideoMark = (v, name, on) => setMark(v, state.channelsById.get(v.channelId), name, on);

const groupChannels = (group) => (group.channels ? state.meta.channels.filter(group.channels) : []);

// The server keeps when each group was last opened, shared by every device. A tab freezes the value it
// found on its first view of the group, so NEW markers survive reloads until the tab closes.
const baselineKey = (group) => `subfeed.baseline.${group.id}`;

function recordVisit(group, seenAt) {
  state.meta.visits[group.id] = seenAt;
  return api('PUT', `/api/visits/${group.id}`, { seenAt }).catch((err) => failed(`Could not save the visit: ${err.message}`));
}

function beginVisit(group) {
  if (!group.tracksNew || sessionStorage.getItem(baselineKey(group)) !== null) return;
  sessionStorage.setItem(baselineKey(group), state.meta.visits[group.id] ?? defaultBaseline(Date.now()));
  recordVisit(group, new Date().toISOString());
}

// Null for a group without NEW markers. Read it after beginVisit.
const baseline = (group) => (group.tracksNew ? sessionStorage.getItem(baselineKey(group)) : null);

function markAllSeen(group) {
  const now = new Date().toISOString();
  for (const g of groupsMarkedSeen(group, state.groups)) {
    sessionStorage.setItem(baselineKey(g), now);
    recordVisit(g, now);
  }
  render();
}

const isNew = (v, since) => since !== null && v.published > since;
const hasNewSince = (c, since) => latestVisible(c) > since;

const readRoute = () => routeOf(location.hash, state.groups, state.channelsById, prefs.get('group'));

// `searchDepth` counts the history entries a search has pushed, so clearing it can step back to where it began.
function go(route, { replace = false, searchDepth = 0 } = {}) {
  if (hashOf(route) !== location.hash) history[replace ? 'replaceState' : 'pushState'](searchDepth ? { searchDepth } : null, '', hashOf(route));
  applyRoute();
  scrollTo({ top: 0 });
}

function applyRoute() {
  state.route = readRoute();
  if (hashOf(state.route) !== location.hash) history.replaceState(history.state, '', hashOf(state.route));
  prefs.set('group', state.route.group.id);
  syncSearchBox();
  render();
}

const openGroup = (group) => go({ group, channelId: null, q: null });
const openChannel = (channelId) => go({ group: state.route.group, channelId, q: null });

const searchForm = $('search');
const searchBox = $('q');
const searchClear = $('search-clear');
const pushedSearches = () => history.state?.searchDepth ?? 0;
let typing = null;

// The first change pushes a history entry and later ones refine it, so Back leaves the search in one step.
function search(text) {
  clearTimeout(typing);
  const q = text.trim() || null;
  const { group, q: shown } = state.route;
  if (q === shown) return;
  if (!q) return clearSearch();
  go({ group, channelId: null, q }, shown ? { replace: true, searchDepth: pushedSearches() } : { searchDepth: 1 });
}

function clearSearch() {
  clearTimeout(typing);
  searchBox.value = '';
  searchClear.hidden = true;
  if (!state.route.q) return;
  if (pushedSearches()) history.go(-pushedSearches());
  else go({ group: state.route.group, channelId: null, q: null }, { replace: true });
}

function syncSearchBox() {
  const { group, q } = state.route;
  if (searchBox.value.trim() !== (q ?? '')) searchBox.value = q ?? '';
  searchClear.hidden = !searchBox.value;
  searchBox.placeholder = `Search ${group.title}`;
}

searchForm.prepend(icon('search'));
searchClear.append(icon('close'));
searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  search(searchBox.value);
});
searchBox.addEventListener('input', () => {
  searchClear.hidden = !searchBox.value;
  clearTimeout(typing);
  typing = setTimeout(() => search(searchBox.value), 250);
});
searchBox.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (searchBox.value || state.route.q) clearSearch();
  else searchBox.blur();
});
searchClear.addEventListener('click', () => {
  clearSearch();
  searchBox.focus();
});
const help = el('dialog', { className: 'shortcuts', ariaLabel: 'Keyboard shortcuts' },
  el('h2', { textContent: 'Keyboard shortcuts' }),
  el('dl', {}, ...SHORTCUTS.flatMap((s) => [
    el('dt', {}, ...s.keys.flatMap((k, i) => [i ? ' or ' : null, el('kbd', { textContent: k })])),
    el('dd', { textContent: s.label }),
  ])));
help.addEventListener('click', (e) => e.target === help && help.close());
document.body.append(help);

function focusCard(delta) {
  const cards = [...main.querySelectorAll(VIDEO_ITEM)];
  let index = cards.indexOf(document.activeElement?.closest(VIDEO_ITEM));
  if (index < 0) {
    const onScreen = cards.findIndex((c) => c.getBoundingClientRect().bottom > 0);
    index = onScreen < 0 ? -1 : onScreen - delta;
  }
  const target = cards[stepIndex(cards.length, index, delta)];
  if (!target) return;
  target.querySelector('.title').focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

addEventListener('keydown', (e) => {
  const action = shortcutAction(e);
  if (!action || document.documentElement.classList.contains('nav-open')) return;
  if (help.open && action !== 'help') return;
  const press = (selector) => document.activeElement?.closest(VIDEO_ITEM)?.querySelector(selector)?.click();
  e.preventDefault();
  if (action === 'search') {
    searchBox.focus();
    searchBox.select();
  } else if (action === 'help') help.open ? help.close() : help.showModal();
  else if (action === 'next') focusCard(1);
  else if (action === 'previous') focusCard(-1);
  else if (action === 'open') press('.title');
  else if (action === 'later') press('.later');
  else if (action === 'star') press('.star');
});

// Only a channel whose every fetch failed for a day: a few failed refreshes in a row are a slow YouTube or a busy server,
// and the next refresh usually gets the feed.
function renderNotice() {
  const broken = state.meta.channels.filter((c) => c.failingSince && Date.now() - Date.parse(c.failingSince) >= DAY);
  const names = broken.slice(0, 3).map((c) => c.name).join(', ') + (broken.length > 3 ? ` and ${plural(broken.length - 3, 'other')}` : '');
  fill($('notice'), ...(broken.length ? [
    `${names} could not be fetched for over a day. `,
    el('a', { href: 'manage.html', textContent: 'See Manage' }),
  ] : []));
}

const renderNav = () => nav.render({ groups: state.groups, meta: state.meta, current: state.route.group.id });

function syncToggle(selector, on, label) {
  for (const b of document.querySelectorAll(selector)) {
    b.ariaPressed = String(on);
    b.title = label;
  }
}

// Shows a change at once with `set(on)`, and takes it back if the server refuses it.
async function optimistic({ set, on, request, failText }) {
  set(on);
  try {
    await request();
  } catch (err) {
    set(!on);
    failed(`${failText}: ${err.message}`);
  }
}

const favoriteLabel = (on) => (on ? 'Remove from favorites' : 'Add to favorites');

function toggleVideoFavorite(v) {
  const on = !v.favorite;
  return optimistic({
    on,
    set: (value) => {
      if (!setVideoMark(v, 'favorite', value)) return;
      syncToggle(`.card[data-id="${v.id}"] .star`, value, favoriteLabel(value));
      renderNav();
    },
    request: () => api(on ? 'PUT' : 'DELETE', `/api/favorites/${v.id}`),
    failText: 'Could not update favorite',
  });
}

// Looked up by id at click time: a meta refresh replaces the channel objects the button was drawn with.
async function toggleChannelFavorite(id) {
  const channel = state.channelsById.get(id);
  if (!channel) return;
  const on = !channel.favorite;
  await optimistic({
    on,
    set: (value) => {
      channel.favorite = value;
      syncToggle(`[data-channel-star="${channel.id}"]`, value, channelStarLabel(channel));
    },
    request: async () => {
      await api('PATCH', `/api/channels/${channel.id}`, { favorite: on });
      state.meta.favoriteChannels += on ? 1 : -1;
      renderNav();
      // The favorite-channels group is defined by these stars, so its contents change.
      if (state.route.group.id === 'favorite-channels' && !state.route.channelId) render();
    },
    failText: 'Could not update favorite channel',
  });
}

// The page lists only subscribed channels, so an unsubscribed channel leaves the page and its group opens, with an
// Undo that brings the channel page back while the group is still open. Unsubscribing stops the channel's backfill,
// which Undo does not start again, so then it asks first. Returns whether the change went through.
async function setSubscribed(channel, subscribed) {
  if (!subscribed && backfilling(channel) && !confirm(stopBackfillQuestion([channel]))) return false;
  try {
    await api('PATCH', `/api/channels/${channel.id}`, { subscribed });
    setMeta(await api('GET', '/api/meta'));
  } catch (err) {
    failed(`Could not ${subscribed ? 'resubscribe' : 'unsubscribe'}: ${err.message}`);
    return false;
  }
  if (subscribed) return true;
  go({ group: state.groups.find((g) => g.id === state.route.group.id) ?? state.groups[0], channelId: null, q: null }, { replace: true });
  const hash = location.hash;
  toast(`Unsubscribed from ${channel.name}.`, { undo: async () => {
    if (await setSubscribed(channel, true) && location.hash === hash) go({ group: state.route.group, channelId: channel.id, q: null });
  } });
  return true;
}

const channelStarLabel = (c) => (c.favorite ? `Remove ${c.name} from favorite channels` : `Add ${c.name} to favorite channels`);

const channelStar = (channel, className = 'fav-channel', text = null) => starButton({
  className, pressed: channel.favorite, title: channelStarLabel(channel), dataset: { channelStar: channel.id }, onToggle: () => toggleChannelFavorite(channel.id),
}, text);

// The tallies are kept in step with each change so the sidebar needs no reload.
function setQueued(v, on) {
  if (!setVideoMark(v, 'queued', on)) return false;
  renderNav();
  return true;
}

const laterLabel = (queued) => (queued ? 'Remove from Watch Later' : 'Add to Watch Later');

function toggleQueued(v) {
  const on = !v.queued;
  return optimistic({
    on,
    set: (value) => setQueued(v, value) && syncToggle(`.card[data-id="${v.id}"] .later`, value, laterLabel(value)),
    request: () => api(on ? 'PUT' : 'DELETE', `/api/queue/${v.id}`),
    failText: 'Could not update Watch Later',
  });
}

const watchedLabel = (watched) => (watched ? 'Mark as unwatched' : 'Mark as watched');

// Moves the video between the unwatched tallies and the rest, so the counts under Hide watched stay right.
// A tally set whose rules hide the video does not count it.
function applyWatched(v, on) {
  if (v.watched === on) return;
  const delta = on ? -1 : 1;
  const bucket = bucketOf(v);
  for (const [t, topic] of tallySets(state.channelsById.get(v.channelId))) {
    if (topic === undefined || !ruleHides(state.meta.rules, v, topic)) t.unwatched.counts[bucket] += delta;
    if (v.favorite) t.unwatched.starred[bucket] += delta;
    if (v.queued) t.unwatched.queued[bucket] += delta;
  }
  v.watched = on;
  for (const node of document.querySelectorAll(`[data-id="${v.id}"]`)) node.classList.toggle('watched', on);
  syncToggle(`[data-id="${v.id}"] .seen`, on, watchedLabel(on));
  renderNav();
}

// An upcoming premiere opens on YouTube but cannot be watched yet, so it is not marked.
function setWatched(v, on) {
  if (v.watched === on || !kindOf(v.kind).watchable) return;
  return optimistic({
    on,
    set: (value) => applyWatched(v, value),
    request: () => api(on ? 'PUT' : 'DELETE', `/api/watched/${v.id}`),
    failText: `Could not mark as ${on ? 'watched' : 'unwatched'}`,
  });
}

const markWatched = (v) => setWatched(v, true);

// A thin bar along the bottom of the thumbnail shows how far into the video the player stopped.
function progressBar(v) {
  if (!v.position || !v.durationS) return null;
  const bar = el('span', { className: 'progress' });
  bar.style.setProperty('--at', `${Math.min(100, (100 * v.position) / v.durationS)}%`);
  return bar;
}

function showPosition(v, seconds) {
  v.position = seconds;
  for (const thumb of document.querySelectorAll(`[data-id="${v.id}"] :is(.thumb, .queue-thumb)`)) {
    thumb.querySelector('.progress')?.remove();
    const bar = progressBar(v);
    if (bar) thumb.querySelector('img').after(bar);
  }
}

// The player often saves as the page goes away, so the request has to outlive the page.
async function savePosition(v, seconds) {
  const before = v.position;
  showPosition(v, seconds);
  try {
    if (seconds === null) await api('DELETE', `/api/position/${v.id}`, null, { keepalive: true });
    else await api('PUT', `/api/position/${v.id}`, { seconds }, { keepalive: true });
  } catch (err) {
    // Putting the old place back makes the player's next save send this one again.
    if (v.position === seconds) showPosition(v, before);
    console.warn(`Could not save the place in ${v.id}: ${err.message}`);
  }
}

// An upcoming premiere has no mark watched toggle. Every card repeats these buttons, so their names carry the title.
const seenButton = (v, className) => (!kindOf(v.kind).watchable ? null
  : el('button', { type: 'button', className: `seen ${className}`, ariaPressed: String(v.watched), title: watchedLabel(v.watched), ariaLabel: `Watched: ${v.title}`, onclick: () => setWatched(v, !v.watched) }, icon('check')));

const searchWords = (q) => wordsOf(fold(q));

function highlighted(title, words) {
  if (!words.length) return [title];
  return title.split(new RegExp(`(${WORD.source})`, 'u')).map((part, i) => (i % 2 && words.some((w) => fold(part).startsWith(w)) ? el('mark', { textContent: part }) : part));
}

const lengthBadge = (v) => (v.isShort ? el('span', { className: 'badge short', textContent: 'SHORT' })
  : v.kind === 'upcoming' ? el('span', { className: 'badge upcoming', textContent: 'UPCOMING' })
  : v.durationS ? el('span', { className: 'badge time', textContent: formatDuration(v.durationS) }) : null);

// The title link, then the channel name and age, then `extra`: the text of a card and of a Watch Later row.
function videoText(v, link, { withChannel = true, extra = [] } = {}) {
  return el('div', { className: 'video-text' }, link,
    el('div', { className: 'meta' },
      withChannel ? el('button', { type: 'button', className: 'chan', textContent: v.channelName, title: `All videos from ${v.channelName}`, onclick: () => openChannel(v.channelId) }) : null,
      el('span', { textContent: `${withChannel ? '· ' : ''}${age(v.published)}` }),
      ...extra));
}

// The title link stretches over the whole card; the buttons and the channel name sit above it.
function card(v, { since, withChannel = false, words = [] }) {
  const fresh = isNew(v, since);
  const link = el('a', { className: 'title', href: v.url, target: '_blank', rel: 'noopener', title: v.title }, ...highlighted(v.title, words));
  link.addEventListener('click', (e) => {
    if (wantsTab(e) || !playsHere(v)) return markWatched(v);
    e.preventDefault();
    openPlayer([v], 0, { onWatched: markWatched, onPosition: savePosition });
  });
  link.addEventListener('auxclick', (e) => e.button === 1 && markWatched(v));
  const text = videoText(v, link, { withChannel, extra: [
    v.views === null ? null : el('span', { textContent: `· ${compact.format(v.views)} views` }),
    v.flame ? el('span', { className: 'flame', title: 'Far above this channel\u2019s usual views per hour', textContent: `· 🔥 ${compact.format(v.viewsPerHour)}/h` }) : null,
  ] });
  const thumb = el('div', { className: 'thumb' },
    el('img', { src: v.thumbnail, alt: '', loading: 'lazy', decoding: 'async' }),
    progressBar(v),
    fresh ? el('span', { className: 'badge new', textContent: 'NEW' }) : null,
    lengthBadge(v),
    v.muted ? el('span', { className: 'badge muted', textContent: 'MUTED', title: 'A mute or route rule hides this video; Show muted reveals it' }) : null,
    el('span', { className: 'seen-mark', textContent: 'WATCHED' }));
  const star = starButton({ className: 'card-action star', pressed: v.favorite, title: favoriteLabel(v.favorite), ariaLabel: `Favorite: ${v.title}`, onToggle: () => toggleVideoFavorite(v) });
  const later = el('button', { type: 'button', className: 'card-action later', ariaPressed: String(v.queued), title: laterLabel(v.queued), ariaLabel: `Watch Later: ${v.title}`, onclick: () => toggleQueued(v) }, icon('clock'));
  const body = withChannel ? el('div', { className: 'card-body' }, avatar(v.channelName, 'avatar md', state.channelsById.get(v.channelId).avatar), text) : text;
  return el('article', { className: `card${fresh ? ' new' : ''}${v.watched ? ' watched' : ''}${v.muted ? ' muted' : ''}`, dataset: { id: v.id } }, thumb, body, seenButton(v, 'card-action'), later, star);
}

function chipRow(group, selectedId = null) {
  if (!group.channels) return null;
  const since = baseline(group);
  const channels = groupChannels(group).toSorted((a, b) => visibleCount(b) - visibleCount(a) || a.name.localeCompare(b.name));
  const total = channels.reduce((n, c) => n + visibleCount(c), 0);
  const all = el('button', { type: 'button', className: 'chip all', ariaPressed: String(!selectedId), onclick: () => openGroup(group) },
    el('span', { textContent: 'All channels' }), el('span', { className: 'n', textContent: compact.format(total) }));
  const chips = channels.map((c) => {
    const n = visibleCount(c);
    return el('button', {
      type: 'button', className: `chip${n ? '' : ' no-videos'}`, ariaPressed: String(c.id === selectedId), title: c.name,
      onclick: () => (c.id === selectedId ? openGroup(group) : openChannel(c.id)),
    }, avatar(c.name, 'avatar', c.avatar), el('span', { textContent: c.name }), el('span', { className: 'n', textContent: compact.format(n) }),
    since !== null && hasNewSince(c, since) ? el('span', { className: 'newdot', title: 'New since your last visit' }) : null);
  });
  const strip = el('div', { className: 'chips', role: 'group', ariaLabel: 'Channels' }, all, ...chips);
  // Chip widths change when the web font arrives, so measure after it has.
  if (selectedId) {
    document.fonts.ready.then(() => requestAnimationFrame(() => {
      const pressed = strip.querySelector('.chip[aria-pressed="true"]');
      strip.scrollLeft += pressed.getBoundingClientRect().left - strip.getBoundingClientRect().left - (strip.clientWidth - pressed.offsetWidth) / 2;
    }));
  }
  return strip;
}

const viewSwitch = (group) => segmented({
  label: 'View', current: viewOf(group),
  options: Object.entries(VIEWS).map(([id, view]) => ({ id, ...view })),
  onPick: (id) => {
    state.views[group.id] = id;
    prefs.set('views', state.views);
    render();
  },
});

const sortOf = () => (state.meta.hot ? state.sort : 'newest');

const sortSwitch = () => segmented({
  label: 'Sort', current: sortOf(),
  options: Object.entries(SORTS).map(([id, sort]) => ({ id, ...sort })),
  onPick: (id) => {
    state.sort = id;
    prefs.set('sort', id);
    render();
  },
});

// The labels are symbols such as "<15m", so the buttons are read by their titles.
const lengthSwitch = () => segmented({
  label: 'Video length', current: state.length,
  options: Object.entries(LENGTHS).map(([id, length]) => ({ id, ...length, ariaLabel: length.title })),
  onPick: (id) => {
    state.length = id;
    prefs.set('length', id);
    render();
  },
});

// The channel counts in the page's metadata ignore length, so with a length filter the total is unknown.
const knownTotal = (n) => (state.length === 'any' ? n : null);

function lede(group, since) {
  if (!group.tracksNew) return el('p', { className: 'lede', textContent: 'Everything you starred.' });
  const channels = groupChannels(group);
  const fresh = channels.filter((c) => hasNewSince(c, since)).length;
  if (!fresh) return el('p', { className: 'lede', textContent: `Nothing new since ${when.format(new Date(since))}. ${plural(channels.length, 'channel')}.` });
  return el('p', { className: 'lede' },
    el('b', { textContent: `New from ${plural(fresh, 'channel')}` }), ` since ${when.format(new Date(since))}.`,
    el('button', { type: 'button', className: 'pill-btn', textContent: 'Mark all seen', onclick: () => markAllSeen(group) }));
}

function hero(group, since) {
  const sorts = viewOf(group) === 'feed' && state.meta.hot ? sortSwitch() : null;
  return el('section', { className: 'hero' }, el('h1', { textContent: group.title }), lede(group, since), el('div', { className: 'hero-tools' }, viewSwitch(group), sorts, lengthSwitch()));
}

const emptyBlock = (title, ...text) => el('div', { className: 'empty' }, el('b', { textContent: title }), ...text);

// A starred group is empty because nothing is starred yet; any other group because of the filters.
function emptyState(group) {
  const nothingStarred = group.empty && !groupChannels(group).length;
  return emptyBlock(...(nothingStarred ? group.empty : ['Nothing here', 'No videos match these filters.']));
}

// When the new meta lacks a channel the tab knew (unsubscribed in another tab), the route opens again as routeOf
// resolves it, so no card of that channel stays on screen. Otherwise the route only takes the new group object,
// so the screen keeps its place.
async function refreshMeta() {
  const before = state.channelsById;
  setMeta(await api('GET', '/api/meta'));
  const route = readRoute();
  if (hashOf(route) !== location.hash || dropsChannel(before, state.channelsById)) return applyRoute();
  state.route = route;
  renderNav();
}

const withChannels = async (page) => {
  if (unknownChannelIds(page, state.channelsById).length) await refreshMeta();
  return page;
};

// A search's first page carries its total, which replaces `total` and goes to `onTotal`.
// Its requests stop when the next render starts, so the server drops a search typed past before it runs.
function pages({ path, params, generation, sentinel, append, total, onEmpty, onTotal, moreLabel = 'Load older', skeleton = {} }) {
  let loaded = 0;
  let capped = false;
  const { signal } = renderAbort;
  pager({
    sentinel, rootMargin: '1200px', isCurrent: () => isCurrentRender(generation),
    placeholder: (first) => (first ? skeletonGrid(skeleton) : loadingMore()),
    fetchPage: (cursor) => {
      const q = new URLSearchParams(params);
      if (cursor) q.set('before', cursor);
      return api('GET', `${path}?${q}`, undefined, { signal }).then(withChannels);
    },
    onPage: (page, more) => {
      if (page.total !== undefined) {
        total = page.total;
        capped = page.totalCapped === true;
        onTotal(total, capped);
      }
      append(page.videos);
      loaded += page.videos.length;
      if (!loaded) fill(sentinel, onEmpty());
      else if (!page.nextCursor) fill(sentinel, `${plural(loaded, 'video')}. That is everything.`);
      else fill(sentinel, `${whole.format(loaded)}${total ? ` of ${whole.format(total)}${capped ? '+' : ''}` : ''}`, el('button', { type: 'button', textContent: moreLabel, onclick: more }));
    },
    failure: (err) => el('span', { className: 'error', textContent: `Could not load videos: ${err.message}` }),
  });
}

function sectionedAppender(container, { sectionOf, since = null, visitRule = true, gridClass = 'grid', withChannel = false, words = [] }) {
  let section = null;
  let seenOld = since === null || !visitRule;
  let anyNew = false;
  return (videos) => {
    for (const v of videos) {
      const p = sectionOf(v.published);
      const crossing = !seenOld && !isNew(v, since);
      if (crossing) seenOld = true;
      const rule = crossing && anyNew ? el('div', { className: 'visit-rule', textContent: `LAST VISIT · ${when.format(new Date(since)).toUpperCase()}` }) : null;
      if (p.key !== section?.key) {
        const count = el('span', { className: 'n' });
        const grid = el('div', { className: gridClass });
        const node = el('section', { className: 'period' }, rule, el('div', { className: 'period-head' }, el('h2', { textContent: p.label }), el('span', { className: 'rule' }), count), grid);
        container.append(node);
        section = { key: p.key, grid, count, n: 0 };
      } else if (rule) section.grid.append(rule);
      if (isNew(v, since)) anyNew = true;
      section.grid.append(card(v, { since, withChannel, words }));
      section.count.textContent = whole.format(++section.n);
    }
  };
}

// `params` with the sidebar filters and the length filter, for /api/videos and /api/shelves.
const listQuery = (params) => new URLSearchParams({ ...params, ...filterParams(filters), length: state.length });

// Quiet channels, with no video in the current filter, are listed once the last page is in.
function renderShelves(group, generation) {
  beginVisit(group);
  const since = baseline(group);
  const list = el('div', {});
  const sentinel = el('div', { className: 'more' });
  fill(main, hero(group, since), chipRow(group), list, sentinel);
  const shown = new Set();
  pager({
    sentinel, rootMargin: '1600px', isCurrent: () => isCurrentRender(generation),
    placeholder: (first) => (first ? skeletonShelves() : loadingMore('Loading more channels')),
    fetchPage: (cursor) => api('GET', `/api/shelves?${listQuery({ ...group.params, perChannel: PER_SHELF, channels: SHELF_PAGE, ...(cursor && { after: cursor }) })}`).then(withChannels),
    onPage: (page, more) => {
      list.append(...page.shelves.map((s, i) => shelf(s, since, i)));
      for (const s of page.shelves) shown.add(s.channelId);
      if (page.nextCursor) return fill(sentinel, el('button', { type: 'button', textContent: 'Load more channels', onclick: more }));
      const quiet = groupChannels(group).filter((c) => !shown.has(c.id)).toSorted((a, b) => a.name.localeCompare(b.name));
      sentinel.className = '';
      fill(sentinel,
        quiet.length ? el('p', { className: 'quiet' }, el('b', { textContent: 'Quiet' }), quiet.map((c) => c.name).join(', ')) : null,
        shown.size ? null : emptyState(group));
    },
    failure: (err) => emptyBlock('Could not load', err.message),
  });
}

function shelf({ channelId, latest, videos }, since, index) {
  const channel = state.channelsById.get(channelId);
  const total = visibleCount(channel);
  const nNew = videos.filter((v) => isNew(v, since)).length;
  const more = nNew === videos.length && total > videos.length;
  const track = el('div', { className: 'track' });
  videos.forEach((v, i) => {
    track.append(card(v, { since }));
    if (nNew && i === nNew - 1 && i < videos.length - 1) track.append(el('div', { className: 'marker', title: `Last visit ${when.format(new Date(since))}` }, el('span', { textContent: 'LAST VISIT' })));
  });
  track.append(el('button', { type: 'button', className: 'tile', onclick: () => openChannel(channel.id) },
    el('span', { textContent: 'See all' }), el('b', { textContent: compact.format(total) }), el('span', { textContent: total === 1 ? 'video' : 'videos' })));
  const scroll = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: 'smooth' });
  const prev = el('button', { type: 'button', className: 'nav-btn prev', title: 'Scroll left', onclick: () => scroll(-1) }, icon('back'));
  const next = el('button', { type: 'button', className: 'nav-btn next', title: 'Scroll right', onclick: () => scroll(1) }, icon('arrow'));
  const syncNav = () => {
    prev.disabled = track.scrollLeft < 8;
    next.disabled = track.scrollLeft + track.clientWidth > track.scrollWidth - 8;
  };
  track.addEventListener('scroll', syncNav, { passive: true });
  requestAnimationFrame(syncNav);
  const node = el('section', { className: 'shelf', dataset: { channel: channel.id } },
    el('header', { className: 'shelf-head' },
      avatar(channel.name, 'avatar', channel.avatar),
      el('h2', {}, el('button', { type: 'button', textContent: channel.name, title: `All videos from ${channel.name}`, onclick: () => openChannel(channel.id) })),
      nNew ? el('span', { className: 'new-count', textContent: `${nNew}${more ? '+' : ''} NEW` }) : null,
      channelStar(channel),
      el('span', { className: 'last', textContent: `latest ${age(latest)}` }),
      el('button', { type: 'button', className: 'see-all', onclick: () => openChannel(channel.id) }, `All ${compact.format(total)}`, icon('arrow'))),
    el('div', { className: 'track-wrap' }, prev, track, next));
  node.style.animationDelay = `${Math.min(index, 8) * 40}ms`;
  return node;
}

function renderFeed(group, generation) {
  beginVisit(group);
  const since = baseline(group);
  const body = el('div', {});
  const sentinel = el('div', { className: 'more' });
  fill(main, hero(group, since), chipRow(group), body, sentinel);
  const hot = sortOf() === 'hot';
  // Hot covers only the last 14 days, so the channel counts are no total for it.
  const total = group.channels && !hot ? knownTotal(groupChannels(group).reduce((n, c) => n + visibleCount(c), 0)) : null;
  pages({
    path: '/api/videos', params: listQuery({ ...group.params, limit: PAGE, ...(hot && { sort: 'hot' }) }), generation, sentinel, total,
    append: hot
      ? sectionedAppender(body, { sectionOf: () => HOT_SECTION, since, visitRule: false, withChannel: true })
      : sectionedAppender(body, { sectionOf: period, since, withChannel: true }),
    onEmpty: () => emptyState(group),
    skeleton: { withChannel: true },
    ...(hot && { moreLabel: 'Load more' }),
  });
}

function renderChannel(group, channelId, generation) {
  const channel = state.channelsById.get(channelId);
  beginVisit(group);
  const since = baseline(group);
  const total = visibleCount(channel);
  const latest = latestVisible(channel);
  const { counts } = tallies(channel);
  const watchedHidden = filters.hideWatched ? countOf(ruled(channel).counts, filters.hideShorts, filters.hideStreams) - total : 0;
  const facts = [channel.handle, plural(total, 'video'), latest && `latest ${age(latest)}`, filters.hideShorts && counts.short ? `${whole.format(counts.short)} Shorts hidden` : null,
    filters.hideStreams && counts.stream ? `${plural(counts.stream, 'stream')} hidden` : null, watchedHidden ? `${whole.format(watchedHidden)} watched hidden` : null];
  const body = el('div', {});
  const sentinel = el('div', { className: 'more' });
  fill(main,
    el('div', { className: 'crumbs' }, el('button', { type: 'button', className: 'back', onclick: () => openGroup(group) }, icon('back'), group.title)),
    el('section', { className: 'channel-hero' }, avatar(channel.name, 'avatar lg', channel.avatar),
      el('div', {},
        el('h1', { textContent: channel.name }),
        el('p', { textContent: facts.filter(Boolean).join(' · ') }),
        el('div', { className: 'channel-actions' },
          channelStar(channel, 'pill-btn', el('span', { textContent: 'Favorite channel' })),
          el('a', { className: 'pill-btn', href: youtubeChannelUrl(channel), target: '_blank', rel: 'noopener' }, icon('external'), 'Open on YouTube'),
          el('button', { type: 'button', className: 'pill-btn unsubscribe', onclick: () => setSubscribed(channel, false) }, icon('close'), 'Unsubscribe'),
          lengthSwitch()))),
    chipRow(group, channelId),
    body,
    sentinel);
  pages({
    // Opened from a topic's group, the channel lists what the group's rules let in, as its chip counts.
    path: '/api/videos', params: listQuery({ channel: channelId, ...(group.params.topic && { topic: group.params.topic }), limit: PAGE }), generation, sentinel, total: knownTotal(total),
    append: sectionedAppender(body, { sectionOf: month, since, gridClass: 'grid compact' }),
    skeleton: { gridClass: 'grid compact', cards: 10 },
    onEmpty: () => emptyBlock('No videos',
      state.length !== 'any' ? `None of this channel's videos is ${LENGTHS[state.length].title.toLowerCase()} long.`
      : watchedHidden ? 'You have watched every video here, and watched videos are hidden.'
      : filters.hideShorts && filters.hideStreams ? 'This channel has only Shorts and streams, which are hidden.'
      : filters.hideShorts ? 'This channel has only Shorts, which are hidden.'
      : filters.hideStreams ? 'This channel has only streams, which are hidden.' : 'Nothing stored for this channel yet.'),
  });
}

// Search results are ranked, not dated, so they share one section.
const bestMatches = () => ({ key: 'best', label: 'Best matches' });

// Search results have no NEW markers: they never count as a visit to the group.
function renderSearch(group, q, generation) {
  const everything = state.groups.find((g) => g.id === 'all');
  const scope = group.id === everything.id ? 'every channel' : group.title;
  const count = el('span', { textContent: 'Searching…' });
  const widen = group.id === everything.id ? null
    : el('button', { type: 'button', className: 'pill-btn', textContent: 'Search everything', onclick: () => go({ group: everything, channelId: null, q }, { searchDepth: pushedSearches() + 1 }) });
  const body = el('div', {});
  const sentinel = el('div', { className: 'more' });
  fill(main,
    el('section', { className: 'hero' },
      el('p', { className: 'kicker', textContent: `Search · ${group.title}` }),
      el('h1', { textContent: `“${q}”` }),
      el('p', { className: 'lede' }, count, widen),
      el('div', { className: 'hero-tools' }, lengthSwitch())),
    body, sentinel);
  pages({
    path: '/api/videos', params: listQuery({ ...group.params, q, limit: PAGE }), generation, sentinel, total: null,
    append: sectionedAppender(body, { sectionOf: bestMatches, withChannel: true, words: searchWords(q) }),
    skeleton: { withChannel: true },
    onTotal: (n, capped) => fill(count, el('b', { textContent: capped ? `${whole.format(n)}+ matches` : plural(n, 'match', 'matches') }), ` in ${scope}.`),
    onEmpty: () => emptyBlock('No matches', `No title or description in ${scope} matches “${q}”.`),
  });
}

// The Watch Later page on screen, so the player can take an ended video off it. Set by renderQueue, cleared by render.
let queueView = null;
// A video that ends, or opens on YouTube from the player, comes off the queue. Off the page, it comes off without Undo.
const playerDone = (v) => v.queued && (queueView ? queueView.take(v, 'Watched') : toggleQueued(v));

// A move names the row it lands in front of, so it stays right while Shorts are hidden.
function renderQueue(group, generation) {
  const order = state.queueOrder;
  const movable = order === 'queue';
  const lede = el('p', { className: 'lede' }, el('span', { className: 'skel-box skel-line lede', ariaHidden: 'true' }));
  const list = el('ol', { className: 'queue' });
  const body = el('div', {});
  const orderSwitch = segmented({
    label: 'Order', current: order,
    options: Object.entries(QUEUE_ORDERS).map(([id, o]) => ({ id, ...o })),
    onPick: (id) => {
      state.queueOrder = id;
      prefs.set('queueOrder', id);
      render();
    },
  });
  fill(main, el('section', { className: 'hero' }, el('h1', { textContent: group.title }), lede, el('div', { className: 'hero-tools' }, orderSwitch)), body);
  fill(body, skeletonQueue());

  const rows = () => [...list.children];
  const idAfter = (row) => row?.nextElementSibling?.dataset.id ?? null;
  const syncLede = () => {
    const n = list.children.length;
    lede.textContent = n ? `${plural(n, 'video')}, ${QUEUE_ORDERS[order].lede}. Play one to work through the queue; each video comes off once it ends or opens on YouTube.` : '';
    if (!n) fill(body, emptyState(group));
    rows().forEach((row, i) => {
      row.querySelector('.pos').textContent = whole.format(i + 1);
      if (!movable) return;
      row.querySelector('.up').disabled = i === 0;
      row.querySelector('.down').disabled = i === n - 1;
    });
  };

  // Saves the place a row has been moved to: in front of the video `before`, the row that now follows it.
  async function saveMove(row, before) {
    syncLede();
    try {
      await api('PUT', `/api/queue/${row.dataset.id}`, { before });
    } catch (err) {
      failed(`Could not move the video: ${err.message}`);
      if (isCurrentRender(generation)) render();
    }
  }

  // Takes the video off the queue, with an Undo that puts it back in front of the row that followed it.
  async function take(v, verb) {
    const row = list.querySelector(`[data-id="${v.id}"]`);
    const before = idAfter(row);
    row?.remove();
    setQueued(v, false);
    syncLede();
    try {
      await api('DELETE', `/api/queue/${v.id}`);
    } catch (err) {
      setQueued(v, true);
      failed(`Could not update Watch Later: ${err.message}`);
      if (isCurrentRender(generation)) render();
      return;
    }
    toast(`${verb} “${v.title}”.`, { undo: async () => {
      try {
        await api('PUT', `/api/queue/${v.id}`, { before });
        setQueued(v, true);
        if (isCurrentRender(generation)) render();
      } catch (err) {
        failed(`Could not undo: ${err.message}`);
      }
    } });
  }

  queueView = { take };
  const byId = new Map();

  // The dragged row follows the pointer; the drop sends the one move that put it there.
  const sorter = sortable(list, { onMove: (row, { before }) => saveMove(row, before) });
  const queueRow = (v) => {
    byId.set(v.id, v);
    // An upcoming premiere opens on YouTube and stays queued: it cannot be watched yet.
    const open = (e) => {
      if (!playsHere(v)) return;
      if (wantsTab(e)) {
        markWatched(v);
        take(v, 'Watched');
        return;
      }
      e.preventDefault();
      const videos = rows().map((r) => byId.get(r.dataset.id));
      openPlayer(videos, videos.indexOf(v), { playThrough: true, onWatched: markWatched, onDone: playerDone, onPosition: savePosition });
    };
    const link = (props, ...children) => {
      const a = el('a', { href: v.url, target: '_blank', rel: 'noopener', draggable: false, ...props }, ...children);
      a.addEventListener('click', open);
      a.addEventListener('auxclick', (e) => e.button === 1 && open(e));
      return a;
    };
    const row = el('li', { className: `queue-row${v.watched ? ' watched' : ''}`, dataset: { id: v.id } },
      el('span', { className: 'grip', ariaHidden: 'true' }, icon('grip')),
      el('span', { className: 'pos' }),
      link({ className: 'queue-thumb', tabIndex: -1, ariaHidden: 'true' },
        el('img', { src: v.thumbnail, alt: '', loading: 'lazy', decoding: 'async', draggable: false }),
        progressBar(v),
        lengthBadge(v)),
      videoText(v, link({ className: 'title', title: v.title, textContent: v.title })),
      el('div', { className: 'queue-actions' },
        movable && el('button', { type: 'button', className: 'icon-btn up', title: 'Move up', ariaLabel: `Move ${v.title} up`, onclick: () => (row.previousElementSibling.before(row), saveMove(row, idAfter(row))) }, icon('up')),
        movable && el('button', { type: 'button', className: 'icon-btn down', title: 'Move down', ariaLabel: `Move ${v.title} down`, onclick: () => (row.nextElementSibling.after(row), saveMove(row, idAfter(row))) }, icon('down')),
        seenButton(v, 'icon-btn'),
        el('button', { type: 'button', className: 'icon-btn later', ariaPressed: 'true', title: 'Remove from Watch Later', ariaLabel: `Remove ${v.title} from Watch Later`, onclick: () => take(v, 'Removed') }, icon('clock'))));
    if (!movable) return row;
    if (finePointer()) row.draggable = true;
    sorter.attach(row);
    return row;
  };

  const { shorts, streams } = filterParams(filters);
  api('GET', `/api/queue?${new URLSearchParams({ shorts, streams, order })}`).then(({ videos }) => {
    if (!isCurrentRender(generation)) return;
    sorter.fill(...videos.map(queueRow));
    fill(body, list);
    syncLede();
  }, (err) => {
    if (!isCurrentRender(generation)) return;
    lede.textContent = '';
    fill(body, emptyBlock('Could not load', err.message));
  });
}

const VIEWS = {
  shelves: { label: 'Shelves', icon: 'shelves', render: renderShelves },
  feed: { label: 'Feed', icon: 'grid', render: renderFeed },
};
const viewOf = (group) => (state.views[group.id] in VIEWS ? state.views[group.id] : 'shelves');

// A new database, or one whose every channel is unsubscribed, has nothing to show on any page but this.
function renderNoChannels() {
  fill(main, emptyBlock('No channels yet', 'Add a channel by its @handle or URL, or import your YouTube subscriptions.',
    el('div', { className: 'empty-actions' },
      el('a', { className: 'pill-btn', href: 'manage.html', textContent: 'Add a channel' }),
      el('a', { className: 'pill-btn', href: 'manage.html#import-title', textContent: 'Import subscriptions' }))));
}

function render() {
  const generation = ++state.generation;
  renderAbort.abort();
  renderAbort = new AbortController();
  queueView = null;
  const { group, channelId, q } = state.route;
  renderNav();
  document.title = q ? `“${q}” · subfeed` : channelId ? `${state.channelsById.get(channelId).name} · subfeed` : `${group.title} · subfeed`;
  if (!state.meta.channels.length) renderNoChannels();
  else if (q) renderSearch(group, q, generation);
  else if (channelId) renderChannel(group, channelId, generation);
  else if (group.queue) renderQueue(group, generation);
  else VIEWS[viewOf(group)].render(group, generation);
}

function setMeta(meta) {
  state.meta = meta;
  state.channelsById = new Map(meta.channels.map((c) => [c.id, c]));
  state.groups = buildGroups(meta);
  renderNotice();
}

// The first load fills the page, so its failure takes the page with a Try again. A later one is a refresh from the
// sidebar, and the page stays as it was.
async function load(refresh = false) {
  nav.setRefreshing(true);
  if (!state.meta) fill(main, skeletonPage());
  try {
    let meta = await api('GET', '/api/meta');
    // Only an empty database waits for the startup refresh (the server shares the in-flight run). After a
    // restart the stored videos show at once, even though this server has not refreshed yet.
    if (!state.meta && !meta.totalVideos && meta.channels.length) fill(main, skeletonPage('Fetching your channels for the first time. This takes a moment.'));
    if (refresh || !meta.totalVideos) meta = await api('POST', '/api/refresh');
    setMeta(meta);
    applyRoute();
  } catch (err) {
    if (state.meta) failed(`Could not refresh: ${err.message}`);
    else fill(main, emptyBlock('Could not load', err.message, el('div', { className: 'empty-actions' }, el('button', { type: 'button', className: 'pill-btn', textContent: 'Try again', onclick: () => load() }))));
  } finally {
    nav.setRefreshing(false);
  }
}

addEventListener('popstate', () => state.meta && applyRoute());
// A failed refresh here is not shown: the next page that names an unknown channel fetches meta again.
document.addEventListener('visibilitychange', () => !document.hidden && state.meta && refreshMeta().catch(() => {}));

load();
registerServiceWorker();
