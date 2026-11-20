import { el, fill, icon, prefs } from './dom.js';
import { FILTERS } from './filters.js';
import { groupHasNew, groupSize } from './groups.js';
import { isTyping } from './shortcuts.js';
import { compact, plural, whole } from './vocab.js';

// Below this width the sidebar is a drawer opened from the top bar's menu button.
const DESKTOP = matchMedia('(min-width: 900px)');
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

// The rest of the content sits in a .page wrapper. Without `onPick(group)` the links load the video page.
export function mountNav({ nav, opener, backdrop, managing = false, onPick = null, onFilterChange, onRefresh }) {
  const root = document.documentElement;
  const filters = Object.fromEntries(FILTERS.map((f) => [f.key, prefs.get(f.pref, f.initial)]));
  let moreOpen = prefs.get('navMoreOpen', false);

  const lists = el('nav', { className: 'nav-scroll', ariaLabel: 'Groups' });
  const switches = FILTERS.map((f) => {
    const input = el('input', { type: 'checkbox', checked: filters[f.key], onchange: () => {
      filters[f.key] = input.checked;
      prefs.set(f.pref, input.checked);
      onFilterChange();
    } });
    return el('label', { className: 'nav-item nav-switch', title: f.title }, el('span', { className: 'switch' }, input), el('span', { className: 'nav-name', textContent: f.label }));
  });
  const refreshAt = el('span', { className: 'nav-n' });
  const units = el('small');
  const refresh = el('button', { type: 'button', className: 'nav-item', title: 'Refresh feeds', onclick: onRefresh },
    el('span', { className: 'nav-tile' }, icon('refresh')), el('span', { className: 'nav-name nav-stack' }, el('span', { textContent: 'Refresh' }), units), refreshAt);
  const manageTile = el('span', { className: 'nav-tile' });
  const manage = el('a', { className: 'nav-item', href: 'manage.html', ariaCurrent: managing ? 'page' : null },
    manageTile, el('span', { className: 'nav-name', textContent: 'Manage' }));
  const compactToggle = el('button', { type: 'button', className: 'nav-item nav-toggle', onclick: () => setCompact(!root.classList.contains('nav-compact')) },
    el('span', { className: 'nav-tile' }, icon('rail')), el('span', { className: 'nav-name', textContent: 'Compact' }), el('kbd', { textContent: '[' }));
  fill(nav,
    el('div', { className: 'nav-head' },
      el('a', { className: 'brand', href: './#/all', ariaLabel: 'subfeed, Everything' },
        el('span', { className: 'brand-full' }, 'Sub', el('span', { textContent: '/' }), 'feed'),
        el('span', { className: 'brand-mark', ariaHidden: 'true' }, 'S', el('span', { textContent: '/' }))),
      el('button', { type: 'button', className: 'icon-btn nav-close', ariaLabel: 'Close groups', onclick: () => setOpen(false) }, icon('close'))),
    lists,
    el('div', { className: 'nav-foot' },
      ...switches,
      refresh, manage, compactToggle));

  function setCompact(on) {
    root.classList.toggle('nav-compact', on);
    prefs.set('navCompact', on);
    compactToggle.ariaPressed = String(on);
    compactToggle.title = on ? 'Expand the sidebar  [' : 'Compact the sidebar  [';
  }
  setCompact(root.classList.contains('nav-compact'));

  // The open drawer is modal: the rest of the page is inert and Tab wraps inside the sidebar.
  const outside = () => [document.querySelector('.top'), document.querySelector('.page')];
  function setOpen(open) {
    if (open === root.classList.contains('nav-open')) return;
    root.classList.toggle('nav-open', open);
    opener.ariaExpanded = String(open);
    for (const node of outside()) node.inert = open;
    if (open) (nav.querySelector('[aria-current="page"]') ?? nav.querySelector('a, button')).focus();
    else opener.focus({ preventScroll: true });
  }
  opener.append(icon('menu'));
  opener.addEventListener('click', () => setOpen(true));
  backdrop.addEventListener('click', () => setOpen(false));
  DESKTOP.addEventListener('change', () => setOpen(false));
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !root.classList.contains('nav-open')) return;
    const focusable = [...nav.querySelectorAll('a, button, input, summary')].filter((n) => n.offsetParent !== null);
    const edge = e.shiftKey ? focusable[0] : focusable.at(-1);
    if (document.activeElement === edge) {
      e.preventDefault();
      (e.shiftKey ? focusable.at(-1) : focusable[0]).focus();
    }
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('nav-open')) setOpen(false);
    if (e.key === '[' && !isTyping(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey && DESKTOP.matches) setCompact(!root.classList.contains('nav-compact'));
  });

  function item(group, { meta, current }) {
    const size = groupSize(group, meta, filters);
    const fresh = group.id !== current && groupHasNew(group, meta, filters);
    // The two library tiles would look alike in the rail, so each star carries the label's first letter.
    const tile = group.starred ? [icon('star'), el('span', { textContent: group.label[0] })]
      : group.queue ? [icon('clock')]
      : [group.monogram ? el('span', { textContent: group.monogram }) : icon('grid')];
    const link = el('a', {
      className: 'nav-item', href: `./#/${group.id}`, title: group.starred ? `★ ${group.label}` : group.label, dataset: { group: group.id },
      ariaLabel: `${group.starred ? `Starred ${group.label.toLowerCase()}` : group.label}, ${whole.format(size)} ${group.queue ? 'queued' : 'videos'}${fresh ? ', new since your last visit' : ''}`,
    },
    el('span', { className: `nav-tile${group.starred ? ' gold' : ''}`, ariaHidden: 'true' }, ...tile, fresh ? el('span', { className: 'newdot' }) : null),
    el('span', { className: 'nav-name', textContent: group.label }),
    el('span', { className: 'nav-n', textContent: compact.format(size) }));
    if (group.id === current) link.ariaCurrent = 'page';
    link.addEventListener('click', (e) => {
      setOpen(false);
      if (!onPick || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      onPick(group);
    });
    return el('li', {}, link);
  }

  // Hidden topics fold under More. The fold opens by itself while one of them is shown.
  function more(hidden, { meta, current }) {
    if (!hidden.length) return null;
    const holdsCurrent = hidden.some((g) => g.id === current);
    const fresh = hidden.some((g) => g.id !== current && groupHasNew(g, meta, filters));
    const fold = el('details', { className: 'nav-more', open: moreOpen || holdsCurrent },
      el('summary', { className: 'nav-item', title: `More topics (${hidden.length})`, dataset: { group: 'more' } },
        el('span', { className: 'nav-tile', ariaHidden: 'true' }, icon('more'), fresh ? el('span', { className: 'newdot' }) : null),
        el('span', { className: 'nav-name', textContent: 'More' })),
      el('ul', { className: 'nav-list' }, ...hidden.map((g) => item(g, { meta, current }))));
    fold.addEventListener('toggle', () => {
      if (fold.open === (moreOpen || holdsCurrent)) return;
      moreOpen = fold.open;
      prefs.set('navMoreOpen', moreOpen);
    });
    return fold;
  }

  return {
    filters,

    render({ groups, meta, current }) {
      const focused = document.activeElement?.dataset?.group;
      const list = (gs) => el('ul', { className: 'nav-list' }, ...gs.map((g) => item(g, { meta, current })));
      const label = (text) => el('h2', { className: 'nav-label', textContent: text });
      // Library is a fixed three, so it sits above the topics, which grow, and stays on a short screen.
      const topics = groups.filter((g) => g.id !== 'all' && !g.library);
      fill(lists, list(groups.filter((g) => g.id === 'all')),
        label('Library'), list(groups.filter((g) => g.library)),
        label('Groups'), list(topics.filter((g) => !g.hidden)), more(topics.filter((g) => g.hidden), { meta, current }));
      const newOnYoutube = meta.youtubeSubscriptions?.newChannels ?? 0;
      fill(manageTile, icon('sliders'), newOnYoutube ? el('span', { className: 'newdot' }) : null);
      manage.title = newOnYoutube ? `Manage channels and topics: ${plural(newOnYoutube, 'channel')} you subscribe to on YouTube to review` : 'Manage channels and topics';
      // The closed drawer hides the dots, so the menu button carries one for them.
      opener.classList.toggle('has-new', lists.querySelector('.newdot') !== null || newOnYoutube > 0);
      if (focused) lists.querySelector(`[data-group="${CSS.escape(focused)}"]`)?.focus();
      refreshAt.textContent = meta.lastRefresh ? clock.format(new Date(meta.lastRefresh)) : '';
      units.textContent = `${whole.format(meta.apiUnits.today)} API units today`;
      refresh.title = `${meta.lastRefresh ? `Refresh feeds (last ${new Date(meta.lastRefresh).toLocaleTimeString()})` : 'Refresh feeds'}. YouTube API units used today: ${whole.format(meta.apiUnits.today)}; the quota resets at midnight Pacific time.`;
    },
    setRefreshing(on) {
      refresh.disabled = on;
    },
  };
}
