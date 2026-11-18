import { el, fill } from './dom.js';

// `more` in `onPage(page, more)` loads the next page, for a button. `failure(err)` is what the sentinel shows
// above Try again.
export function pager({ sentinel, rootMargin, isCurrent, fetchPage, onPage, failure }) {
  let cursor = null;
  let loading = false;
  const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { rootMargin });
  async function more() {
    if (loading) return;
    loading = true;
    fill(sentinel, 'Loading…');
    let failed = false;
    try {
      const page = await fetchPage(cursor);
      if (!isCurrent()) return;
      cursor = page.nextCursor;
      onPage(page, more);
    } catch (err) {
      failed = true;
      if (isCurrent()) fill(sentinel, failure(err), el('button', { type: 'button', textContent: 'Try again', onclick: more }));
    } finally {
      loading = false;
    }
    // Re-observing reports the current intersection, so a page too short to fill the screen loads the next one.
    observer.unobserve(sentinel);
    if (isCurrent() && cursor && !failed) observer.observe(sentinel);
  }
  more();
}

// A channel added in another tab, or through the MCP tool, has videos before this tab's meta knows it.
export function unknownChannelIds(page, known) {
  const ids = [...(page.videos ?? []), ...(page.shelves ?? [])].map((x) => x.channelId);
  return [...new Set(ids)].filter((id) => !known.has(id));
}
