import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// Just enough DOM for pager and dom.js's el and fill.
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    // el() sets only properties a real element has.
    this.type = '';
    this.className = '';
    this.textContent = undefined;
    this.onclick = null;
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  get text() {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent ?? c.text)).join(' ');
  }
}
globalThis.document = { createElement: (tag) => new FakeNode(tag) };

let observers;
globalThis.IntersectionObserver = class {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observed = new Set();
    observers.push(this);
  }
  observe(node) {
    this.observed.add(node);
  }
  unobserve(node) {
    this.observed.delete(node);
  }
};

const { pager, unknownChannelIds } = await import('../public/pager.js');

beforeEach(() => (observers = []));

const settle = () => new Promise((resolve) => setImmediate(resolve));
const button = (sentinel) => sentinel.children.find((c) => c.tag === 'button');

function setup({ pages, current = () => true }) {
  const sentinel = new FakeNode('div');
  const cursors = [];
  const shown = [];
  pager({
    sentinel, rootMargin: '1200px', isCurrent: current,
    fetchPage: async (cursor) => {
      cursors.push(cursor);
      const page = pages.shift();
      if (page instanceof Error) throw page;
      return page;
    },
    onPage: (page, more) => {
      shown.push(...page.items);
      sentinel.replaceChildren(`${shown.length} shown`);
      sentinel.more = more;
    },
    failure: (err) => `Could not load: ${err.message}`,
  });
  return { sentinel, cursors, shown, observer: observers[0] };
}

test('loads the first page at once and follows each cursor while the sentinel stays in view', async () => {
  const { sentinel, cursors, shown, observer } = setup({ pages: [{ items: [1, 2], nextCursor: 'c1' }, { items: [3], nextCursor: null }] });
  assert.equal(sentinel.text, 'Loading…');
  await settle();
  assert.deepEqual(shown, [1, 2]);
  assert.ok(observer.observed.has(sentinel), 'watches for the next page');
  observer.callback([{ isIntersecting: true }]);
  await settle();
  assert.deepEqual(cursors, [null, 'c1']);
  assert.deepEqual(shown, [1, 2, 3]);
  assert.ok(!observer.observed.has(sentinel), 'stops watching after the last page');
});

test('a second trigger while a page loads does not fetch it twice', async () => {
  const { cursors, observer } = setup({ pages: [{ items: [1], nextCursor: 'c1' }] });
  observer.callback([{ isIntersecting: true }]);
  await settle();
  assert.deepEqual(cursors, [null]);
});

test('a failed page offers Try again, which fetches the same cursor', async () => {
  const { sentinel, cursors, shown, observer } = setup({ pages: [{ items: [1], nextCursor: 'c1' }, new Error('offline'), { items: [2], nextCursor: null }] });
  await settle();
  sentinel.more();
  await settle();
  assert.equal(sentinel.text, 'Could not load: offline Try again');
  assert.ok(!observer.observed.has(sentinel), 'a failure stops the automatic loading');
  button(sentinel).onclick();
  await settle();
  assert.deepEqual(cursors, [null, 'c1', 'c1']);
  assert.deepEqual(shown, [1, 2]);
});

test('a page that arrives after the screen changed is dropped', async () => {
  let current = true;
  const { sentinel, shown, observer } = setup({ pages: [{ items: [1], nextCursor: 'c1' }], current: () => current });
  current = false;
  await settle();
  assert.deepEqual(shown, []);
  assert.equal(sentinel.text, 'Loading…');
  assert.ok(!observer.observed.has(sentinel));
});

test('a failure after the screen changed leaves the sentinel alone', async () => {
  let current = true;
  const { sentinel } = setup({ pages: [new Error('offline')], current: () => current });
  current = false;
  await settle();
  assert.equal(sentinel.text, 'Loading…');
});

test('unknownChannelIds names each channel of a page that the tab does not know, once', () => {
  const known = new Map([['UCa', {}]]);
  assert.deepEqual(unknownChannelIds({ videos: [{ channelId: 'UCa' }, { channelId: 'UCb' }, { channelId: 'UCb' }] }, known), ['UCb']);
  assert.deepEqual(unknownChannelIds({ shelves: [{ channelId: 'UCa', videos: [] }, { channelId: 'UCc', videos: [] }] }, known), ['UCc']);
  assert.deepEqual(unknownChannelIds({ videos: [{ channelId: 'UCa' }] }, known), []);
  assert.deepEqual(unknownChannelIds({ videos: [] }, known), []);
});

test('a channel star finds its channel by id when clicked, so a meta refresh does not leave it on a stale object', async () => {
  const app = await (await import('node:fs/promises')).readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /async function toggleChannelFavorite\(id\) \{\n(?:\s*\/\/.*\n)?\s*const channel = state\.channelsById\.get\(id\);/);
  assert.deepEqual(app.match(/toggleChannelFavorite\([^)]*\)/g), ['toggleChannelFavorite(id)', 'toggleChannelFavorite(channel.id)']);
});
