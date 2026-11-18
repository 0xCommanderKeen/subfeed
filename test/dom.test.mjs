import assert from 'node:assert/strict';
import { test } from 'node:test';

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.dataset = {};
    this.children = [];
    this.type = '';
    this.ariaPressed = null;
    this.textContent = '';
  }
  append(...children) {
    this.children.push(...children);
  }
}
globalThis.document = { createElement: (tag) => new FakeElement(tag) };

const { el } = await import('../public/dom.js');

test('el sets known properties and the dataset', () => {
  const node = el('button', { type: 'button', ariaPressed: 'true', dataset: { key: 'k' } }, 'Hide', null);
  assert.equal(node.type, 'button');
  assert.equal(node.ariaPressed, 'true');
  assert.deepEqual(node.dataset, { key: 'k' });
  assert.deepEqual(node.children, ['Hide']);
});

test('el throws on a property the element does not have', () => {
  assert.throws(() => el('button', { pressed: true }), /<button> has no property 'pressed'/);
});
