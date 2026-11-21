import { el } from './dom.js';

// Grey shapes of the page that is on its way, shown while its first answer loads. They fade in after a short delay,
// so an answer that comes back at once never flashes them. Screen readers hear `label` once, not the shapes.
const box = (className) => el('span', { className: `skel-box ${className}` });
const times = (n, make) => Array.from({ length: n }, (_, i) => make(i));

function skeleton(label, className, ...children) {
  return el('div', { className: `skeleton ${className}`, role: 'status', ariaLabel: label },
    el('div', { className: 'skel-shapes', ariaHidden: 'true' }, ...children));
}

const skeletonCard = ({ withChannel }) => el('div', { className: 'skel-card' },
  box('skel-thumb'),
  el('div', { className: 'skel-text' },
    withChannel ? box('skel-avatar') : null,
    el('div', {}, box('skel-line'), box('skel-line short'), box('skel-line meta'))));

// A dated section of cards, as the feed, a channel and a search draw them.
export const skeletonGrid = ({ gridClass = 'grid', withChannel = false, cards = 8 } = {}) =>
  skeleton('Loading videos', 'skel-period',
    el('div', { className: 'skel-head' }, box('skel-line label'), el('span', { className: 'rule' })),
    el('div', { className: gridClass }, ...times(cards, () => skeletonCard({ withChannel }))));

export const skeletonShelves = (shelves = 3) =>
  skeleton('Loading channels', 'skel-shelves', ...times(shelves, () => el('div', { className: 'skel-shelf' },
    el('div', { className: 'skel-shelf-head' }, box('skel-avatar'), box('skel-line name')),
    el('div', { className: 'skel-track' }, ...times(6, () => skeletonCard({ withChannel: false }))))));

export const skeletonQueue = (rows = 6) =>
  skeleton('Loading Watch Later', 'skel-queue', ...times(rows, () => el('div', { className: 'skel-row' },
    box('skel-thumb'), el('div', {}, box('skel-line'), box('skel-line meta')))));

export const skeletonChannels = (rows = 8) =>
  skeleton('Loading channels', 'skel-channels', ...times(rows, () => el('div', { className: 'skel-channel' },
    box('skel-avatar'), el('div', {}, box('skel-line name'), box('skel-line meta')))));

// The page before the first meta: a heading, a line under it and a grid. `caption` replaces the line when there is
// something to say, such as a first fetch that takes a while.
export const skeletonPage = (caption = null) => el('div', {},
  el('section', { className: 'hero skel-hero' }, box('skel-title'),
    caption ? el('p', { className: 'lede', textContent: caption }) : box('skel-line lede')),
  el('div', { className: 'more' }, skeletonGrid({ withChannel: true })));

// Under a list that is already on the page, the next page needs no shapes: three dots say it is coming.
export const loadingMore = (label = 'Loading more videos') =>
  el('span', { className: 'dots', role: 'status', ariaLabel: label }, ...times(3, () => el('span', { ariaHidden: 'true' })));
