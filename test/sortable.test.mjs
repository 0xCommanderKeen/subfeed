import assert from 'node:assert/strict';
import { test } from 'node:test';

// Just enough DOM for sortable.js: a list of rows 10px tall, stacked from y = 0.
class FakeNode {
  constructor(tag, id) {
    this.tag = tag;
    this.id = id;
    this.dataset = { id };
    this.children = [];
    this.parentNode = null;
    this.handlers = {};
    this.classList = { add() {}, remove() {} };
  }
  addEventListener(type, fn) {
    this.handlers[type] = fn;
  }
  fire(type, props = {}) {
    this.handlers[type]?.({ preventDefault() {}, dataTransfer: {}, target: this, ...props });
  }
  closest() {
    return this;
  }
  replaceChildren(...rows) {
    for (const r of this.children) r.parentNode = null;
    this.children = rows;
    for (const r of rows) r.parentNode = this;
  }
  insertBefore(node, ref) {
    this.children = this.children.filter((c) => c !== node);
    const at = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(at, 0, node);
    node.parentNode = this;
  }
  get nextElementSibling() {
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  getBoundingClientRect() {
    return { top: this.parentNode.children.indexOf(this) * 10, height: 10 };
  }
}
globalThis.requestAnimationFrame = () => {};

const { sortable } = await import('../public/sortable.js');

function setup(ids) {
  const list = new FakeNode('ul');
  const moves = [];
  let settled = 0;
  const sorter = sortable(list, { onMove: (row, { position, before }) => moves.push([row.id, position, before]), onSettle: () => settled++ });
  const draw = () => {
    const rows = ids.map((id) => new FakeNode('li', id));
    for (const row of rows) sorter.attach(row);
    sorter.fill(...rows);
    return rows;
  };
  return { list, moves, draw, settled: () => settled };
}

const order = (list) => list.children.map((r) => r.id);
// Drags `row` over the lower half of `over`, which puts it just after `over`.
const dragBelow = (list, row, over) => list.fire('dragover', { target: over, clientY: list.children.indexOf(over) * 10 + 8 });

test('a drop sends the position the row was dropped at and the id of the row it now sits before', () => {
  const { list, moves, draw } = setup(['a', 'b', 'c', 'd']);
  const [a, , c] = draw();
  a.fire('dragstart');
  dragBelow(list, a, c);
  list.fire('drop');
  a.fire('dragend');
  assert.deepEqual(moves, [['a', 2, 'd']]);
  const [, b, , last] = draw();
  b.fire('dragstart');
  dragBelow(list, b, last);
  list.fire('drop');
  assert.deepEqual(moves.at(-1), ['b', 3, null], 'a row dropped last sits before nothing');
});

test('a redraw during a drag waits, so the dropped position counts each row once', () => {
  const { list, moves, draw, settled } = setup(['a', 'b', 'c', 'd']);
  const [a, , c] = draw();
  a.fire('dragstart');
  draw();
  assert.deepEqual(order(list), ['a', 'b', 'c', 'd'], 'the rows under the drag stay in place');
  dragBelow(list, a, c);
  assert.deepEqual(order(list), ['b', 'c', 'a', 'd'], 'no duplicate row');
  list.fire('drop');
  assert.deepEqual(moves, [['a', 2, 'd']]);
  assert.equal(settled(), 0);
  draw();
  assert.equal(list.children.length, 4, 'redraws again once the drag is over');
});

test('a drag that ends where it started, or outside the list, redraws instead of moving', () => {
  const { list, moves, draw, settled } = setup(['a', 'b', 'c']);
  const [a] = draw();
  a.fire('dragstart');
  list.fire('drop');
  assert.equal(settled(), 1);
  const [, b, c] = draw();
  b.fire('dragstart');
  dragBelow(list, b, c);
  assert.deepEqual(order(list), ['a', 'c', 'b']);
  b.fire('dragend');
  assert.deepEqual(order(list), ['a', 'b', 'c'], 'the row goes back where it started');
  assert.equal(settled(), 2);
  assert.deepEqual(moves, []);
});
