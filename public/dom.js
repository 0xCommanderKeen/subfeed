// Strings reach the page only through textContent and properties, never as HTML.
// null, undefined and false children are skipped, so optional parts can be written inline.
// Native append and replaceChildren would print them as text, so build and refill through these.
const present = (child) => child !== null && child !== undefined && child !== false;

export function el(tag, props = {}, ...children) {
  const { dataset, ...rest } = props;
  const node = document.createElement(tag);
  // Assigning a misspelled property only adds an expando, so a typo such as `pressed` would fail silently.
  const unknown = Object.keys(rest).find((key) => !(key in node));
  if (unknown) throw new Error(`el('${tag}'): <${tag}> has no property '${unknown}'`);
  Object.assign(node, rest);
  Object.assign(node.dataset, dataset);
  node.append(...children.filter(present));
  return node;
}

export function fill(node, ...children) {
  node.replaceChildren(...children.filter(present));
}

export async function api(method, path, body, { signal, keepalive = false } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    keepalive,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

export const prefs = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(`subfeed.${key}`)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set: (key, value) => localStorage.setItem(`subfeed.${key}`, JSON.stringify(value)),
};

// Static, trusted markup only. Feed data never goes through here.
const ICONS = {
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8-4.3-4.1 5.9-.8z"/>',
  arrow: '<path d="M9 5l7 7-7 7" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  back: '<path d="M15 5l-7 7 7 7" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  shelves: '<path d="M3 5h18M3 12h18M3 19h18" fill="none" stroke-width="2.4" stroke-linecap="round"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10" fill="none" stroke-width="2.2" stroke-linecap="round"/>',
  search: '<circle cx="11" cy="11" r="6.5" fill="none" stroke-width="2.2"/><path d="M16 16l4.5 4.5" fill="none" stroke-width="2.2" stroke-linecap="round"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  clock: '<circle cx="12" cy="12" r="8.2" fill="none" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  up: '<path d="M6 15l6-6 6 6" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M6 9l6 6 6-6" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  grip: '<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke-width="2.2" stroke-linecap="round"/>',
  mini: '<rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="none" stroke-width="1.9"/><rect x="11.5" y="11.5" width="6.5" height="5" rx="1"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9" fill="none" stroke-width="2" stroke-linecap="round"/><circle cx="15" cy="7" r="2.2" fill="none" stroke-width="2"/><circle cx="9" cy="17" r="2.2" fill="none" stroke-width="2"/>',
  rail: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke-width="1.9"/><path d="M9.5 4.5v15" fill="none" stroke-width="1.9"/><path d="M15.5 10l-2 2 2 2" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  more: '<circle cx="6" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18" cy="12" r="1.8"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
};

export function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="currentColor" stroke-width="0">${ICONS[name]}</svg>`;
  return t.content.firstChild;
}

// The channel's picture over a two-letter monogram tinted by a hue derived from the name.
// The monogram shows when there is no picture URL or the picture fails to load.
export function avatar(name, className = 'avatar', url = null) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
  let hue = 0;
  for (const ch of name) hue = (hue * 31 + ch.codePointAt(0)) % 360;
  const node = el('span', { className, textContent: letters.toUpperCase(), ariaHidden: 'true' });
  node.style.setProperty('--h', hue);
  if (url) {
    const img = el('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer', onerror: () => img.remove() });
    node.append(img);
  }
  return node;
}

export const finePointer = () => matchMedia('(pointer: fine)').matches;

export const youtubeChannelUrl = (c) => `https://www.youtube.com/channel/${c.id}`;

export const channelLink = (c) => el('a', { href: youtubeChannelUrl(c), target: '_blank', rel: 'noopener', className: 'channel-name', textContent: c.name });

// The head of a channel's row on Manage and in the import review. `star` and `extra` may be null.
export function channelHead(c, tick, star, ...extra) {
  return el('div', { className: 'row-head' }, el('label', { className: 'check' }, tick), star, avatar(c.name, 'avatar', c.avatar), channelLink(c), ...extra);
}

// A pill per topic that toggles whether it is in `picked`. `key` names the pills for Manage's focus restore.
export const topicPicker = (topics, picked, onToggle, key = null) => topics.map((t) =>
  el('button', { type: 'button', className: 'pill', textContent: t.name, ariaPressed: String(picked.has(t.id)), dataset: key ? { key: `${key}-${t.id}` } : {}, onclick: () => onToggle(t.id) }));

export const starButton = ({ pressed, title, ariaLabel = null, onToggle, className = 'star', dataset = {} }, text = null) =>
  el('button', { type: 'button', className, title, ariaLabel, ariaPressed: String(pressed), dataset, onclick: onToggle }, icon('star'), text);

// Buttons that pick one of `options`, each `{ id, label, title?, ariaLabel?, icon? }`. Text-only options get the plain
// style. A narrow screen shows only the icon of an option that has one, so its label is also its name.
export function segmented({ label, options, current, onPick }) {
  return el('div', { className: options.some((o) => o.icon) ? 'seg' : 'seg plain', role: 'group', ariaLabel: label },
    ...options.map((o) => el('button', {
      type: 'button', ariaPressed: String(o.id === current), ...(o.title && { title: o.title }), ariaLabel: o.ariaLabel ?? (o.icon ? o.label : null), onclick: () => onPick(o.id),
    }, ...(o.icon ? [icon(o.icon), el('span', { className: 'seg-label', textContent: o.label })] : [o.label]))));
}

const TOAST_MS = 6000;
let toastNode = null;
let toastTimer = null;
let toastSticky = false;

const holdToast = () => clearTimeout(toastTimer);
function closeToast() {
  holdToast();
  toastNode.classList.remove('open');
  fill(toastNode);
}
function releaseToast() {
  holdToast();
  if (!toastSticky) toastTimer = setTimeout(closeToast, TOAST_MS);
}

// The message at the bottom of the page, for what a click did or why it failed. One at a time: a newer message
// replaces the last, and its Undo with it. A message closes after six seconds, but not while the pointer or the
// focus is on it; an error stays until its close button. Needs a `#toast` element with role status. It stays in
// the page, empty when closed, so that a screen reader hears what fills it.
export function toast(text, { undo = null, error = false } = {}) {
  if (!toastNode) {
    toastNode = document.getElementById('toast');
    for (const type of ['mouseenter', 'focusin']) toastNode.addEventListener(type, holdToast);
    for (const type of ['mouseleave', 'focusout']) toastNode.addEventListener(type, releaseToast);
  }
  toastSticky = error;
  toastNode.classList.toggle('error', error);
  toastNode.classList.add('open');
  fill(toastNode, el('span', { textContent: text }),
    undo && el('button', { type: 'button', textContent: 'Undo', onclick: () => (closeToast(), undo()) }),
    error && el('button', { type: 'button', className: 'toast-close', title: 'Close', ariaLabel: 'Close', onclick: closeToast }, icon('close')));
  releaseToast();
}

export const failed = (text) => toast(text, { error: true });

// The service worker keeps the app shell for the installed app. Browsers allow it only over https and on localhost.
export function registerServiceWorker() {
  navigator.serviceWorker?.register('sw.js', { type: 'module' }).catch((err) => console.warn(`service worker: ${err.message}`));
}
