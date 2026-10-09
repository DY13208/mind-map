const test = require('node:test');
const assert = require('node:assert/strict');
const { GraphInteraction } = require('./interaction.js');

test('dragging a node at zoom preserves pointer offset and pins its animation target', () => {
  const view = new GraphInteraction();
  view.scale = 2; view.x = 40; view.y = 20;
  const node = { x: 100, y: 50, targetX: 100, targetY: 50 };
  view.begin(248, 124, node);
  view.move(288, 144);
  assert.deepEqual([node.x, node.y, node.targetX, node.targetY], [120, 60, 120, 60]);
  assert.equal(node.pinned, true);
  assert.equal(view.end(), true);
});

test('blank canvas dragging pans without moving graph nodes', () => {
  const view = new GraphInteraction();
  view.begin(10, 10, null); view.move(60, 30);
  assert.deepEqual([view.x, view.y], [50, 20]);
  assert.deepEqual(view.toWorld(150, 120), { x: 100, y: 100 });
  assert.equal(view.end(), true);
});

test('small pointer movement remains a click and leaves layout unchanged', () => {
  const view = new GraphInteraction();
  const node = { x: 10, y: 20, targetX: 10, targetY: 20 };
  view.begin(10, 20, node); view.move(12, 21);
  assert.equal(view.end(), false);
  assert.equal(node.pinned, undefined);
  assert.equal(node.x, 10);
});

test('wheel zoom stays anchored to the cursor, is bounded, and reset restores view', () => {
  const view = new GraphInteraction();
  view.x = 35; view.y = -15;
  const before = view.toWorld(200, 150);
  view.zoom(200, 150, -200);
  const after = view.toWorld(200, 150);
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
  view.zoom(200, 150, -100000); assert.equal(view.scale, 3);
  view.zoom(200, 150, 100000); assert.equal(view.scale, 0.3);
  view.reset(); assert.deepEqual([view.x, view.y, view.scale], [0, 0, 1]);
});
