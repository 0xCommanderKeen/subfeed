// The video shortcuts, in the order the help overlay lists them. `keys` are KeyboardEvent.key values.
// Enter needs no handler: the focused card's title link opens on Enter by itself.
export const SHORTCUTS = [
  { keys: ['j'], action: 'next', label: 'Next video' },
  { keys: ['k'], action: 'previous', label: 'Previous video' },
  { keys: ['Enter', 'o'], action: 'open', label: 'Open the video' },
  { keys: ['w'], action: 'later', label: 'Add to or remove from Watch Later' },
  { keys: ['s'], action: 'star', label: 'Star or unstar' },
  { keys: ['/'], action: 'search', label: 'Search' },
  { keys: ['['], action: 'compact', label: 'Compact sidebar' },
  { keys: ['?'], action: 'help', label: 'Show these shortcuts' },
];

// The elements j/k move between: video cards, and the rows of the Watch Later page.
export const VIDEO_ITEM = '.card, .queue-row';

// `[` belongs to the sidebar.
const HANDLED = new Map(SHORTCUTS.flatMap((s) => s.keys.filter((k) => k !== 'Enter' && k !== '[').map((k) => [k, s.action])));

// True when the key goes to a text field, so a page shortcut must leave it alone.
export const isTyping = (target) => Boolean(target?.closest?.('input:not([type="checkbox"]), textarea, select, [contenteditable]'));

export function shortcutAction(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return null;
  return HANDLED.get(e.key) ?? null;
}

export function stepIndex(count, index, delta) {
  if (!count) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, index + delta));
}
