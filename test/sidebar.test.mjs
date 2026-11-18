import assert from 'node:assert/strict';
import { test } from 'node:test';

// Just enough DOM for sidebar.js. `in` answers true for any property, so el() accepts every prop it sets.
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.classList = { toggle: () => {}, contains: () => false };
    return new Proxy(this, { has: () => true });
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  addEventListener() {}
  focus() {
    document.activeElement = this;
  }
  *walk() {
    for (const c of this.children) {
      if (!(c instanceof FakeNode)) continue;
      yield c;
      yield* c.walk();
    }
  }
  querySelector(selector) {
    const group = selector.match(/^\[data-group="(.+)"\]$/)?.[1];
    const cls = selector.match(/^\.([\w-]+)$/)?.[1];
    for (const n of this.walk()) {
      if (group !== undefined ? n.dataset.group === group : n.className.split(' ').includes(cls)) return n;
    }
    return null;
  }
}
const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.CSS = { escape: (s) => s };
globalThis.document = {
  documentElement: new FakeNode('html'),
  activeElement: null,
  createElement: (tag) => (tag === 'template' ? { content: { firstChild: new FakeNode('svg') } } : new FakeNode(tag)),
  querySelector: () => null,
};

const { mountNav } = await import('../public/sidebar.js');
const { buildGroups } = await import('../public/groups.js');

const meta = {
  topics: [{ id: 'print', name: '3D Printing', hidden: false }, { id: 'old', name: 'Old Stuff', hidden: true }, { id: 'paint', name: 'Painting', hidden: false }],
  channels: [],
  visits: {},
  lastRefresh: null,
  apiUnits: { today: 0 },
};

function mount() {
  const nav = new FakeNode('aside');
  const sidebar = mountNav({ nav, opener: new FakeNode('button'), backdrop: new FakeNode('div'), onFilterChange() {}, onRefresh() {} });
  const lists = nav.children.find((c) => c.className === 'nav-scroll');
  return { sidebar, lists };
}

// Headings as `# Label`, groups and the More fold by their data-group, in document order.
const entries = (lists) => [...lists.walk()].flatMap((n) => (n.tag === 'h2' ? [`# ${n.textContent}`] : n.dataset.group ? [n.dataset.group] : []));

test('the sidebar lists Everything, then Library, then the topics and the More fold', () => {
  const { sidebar, lists } = mount();
  sidebar.render({ groups: buildGroups(meta), meta, current: 'all' });
  assert.deepEqual(entries(lists), [
    'all',
    '# Library', 'favorite-channels', 'favorites', 'watch-later',
    '# Groups', 'topic:print', 'topic:paint', 'more', 'topic:old',
  ]);
});

test('a re-render of the sidebar gives focus back to the group that had it', () => {
  const { sidebar, lists } = mount();
  sidebar.render({ groups: buildGroups(meta), meta, current: 'all' });
  const before = lists.querySelector('[data-group="watch-later"]');
  before.focus();
  sidebar.render({ groups: buildGroups(meta), meta, current: 'all' });
  assert.notEqual(document.activeElement, before);
  assert.equal(document.activeElement.dataset.group, 'watch-later');
});
