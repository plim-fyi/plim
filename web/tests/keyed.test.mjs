// keyed (ui/shared.js, #442): a list drawn again in place.
import assert from 'node:assert/strict';
import { test } from './lib.mjs';

// (No DOM in Node: an element with just what keyed uses. shared.js reads `document` only when
// asked, and `matchMedia` at load, so a stand-in for that is enough to import it.)
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
const { keyed } = await import('../ui/shared.js');

class Node {
  constructor(name) {
    Object.assign(this, { name, dataset: {}, kids: [], parent: null, text: '' });
  }
  get children() {
    return [...this.kids];
  }
  get firstElementChild() {
    return this.kids[0] ?? null;
  }
  get nextElementSibling() {
    const k = this.parent.kids;
    return k[k.indexOf(this) + 1] ?? null;
  }
  insertBefore(node, ref) {
    node.parent?.kids.splice(node.parent.kids.indexOf(node), 1);
    node.parent = this;
    this.kids.splice(ref ? this.kids.indexOf(ref) : this.kids.length, 0, node);
  }
  remove() {
    this.parent.kids.splice(this.parent.kids.indexOf(this), 1);
    this.parent = null;
  }
}

test('keyed: a list drawn again keeps the elements of items still there, in the new order', () => {
  const list = new Node('ul');
  let made = 0;
  const draw = (items) => keyed(list, items, (i) => i.id, (i) => (made++, new Node(i.id)), (n, i) => (n.text = i.text));
  draw([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }]);
  assert.equal(made, 3);
  const [a, b, c] = list.children;
  assert.deepEqual(list.children.map((n) => n.dataset.key), ['a', 'b', 'c']);

  // The same items, one changed: nothing made, nothing moved, the text updated.
  draw([{ id: 'a', text: 'A' }, { id: 'b', text: 'B2' }, { id: 'c', text: 'C' }]);
  assert.equal(made, 3);
  assert.deepEqual(list.children, [a, b, c]);
  assert.equal(b.text, 'B2');

  // Reordered, one gone, one new: the kept ones are the same elements.
  draw([{ id: 'c', text: 'C' }, { id: 'd', text: 'D' }, { id: 'a', text: 'A' }]);
  assert.equal(made, 4);
  assert.deepEqual(list.children.map((n) => n.dataset.key), ['c', 'd', 'a']);
  assert.equal(list.children[0], c);
  assert.equal(list.children[2], a);
  assert.equal(b.parent, null, 'the one gone is removed');

  // Emptied.
  draw([]);
  assert.deepEqual(list.children, []);
});
