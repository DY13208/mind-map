const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('../../simple-mind-map/node_modules/playwright');
const { createWikiServer } = require('./server.cjs');

test('mouse gestures drag and pin nodes, pan, zoom and preserve article clicks without controls', async t => {
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.WIKI_GRAPH_BROWSER_EXECUTABLE || (fs.existsSync(chrome) ? chrome : undefined) });
  t.after(() => browser.close());
  const server = createWikiServer({ dir: '.', pool: { query: async () => ({ rows: [] }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('**/api/graph', route => route.fulfill({ json: {
    name: '拖动测试', totalSources: 1,
    topics: ['root', 'one', 'two'].map(slug => ({ slug, name: slug, sourceCount: 1 })),
    edges: [{ from: 'root', to: 'one', type: 'structure', concept: null }], concepts: []
  } }));
  await page.route('**/api/topic/*', route => route.fulfill({ json: {
    title: '主题正文', meta: { source_count: 1 }, sections: [{ heading: '内容', content: '正文测试' }]
  } }));
  await page.goto(process.env.WIKI_GRAPH_TEST_URL || ('http://127.0.0.1:' + server.address().port + '/')); 
  await page.waitForFunction(() => nodes.length === 3 && Math.abs(nodes[0].x - nodes[0].targetX) < 0.05 && Math.abs(nodes[0].y - nodes[0].targetY) < 0.05);
  const node = await page.evaluate(() => ({ x: nodes[0].x, y: nodes[0].y }));
  await page.mouse.move(node.x, node.y);
  await page.mouse.down();
  await page.mouse.move(node.x + 130, node.y + 45, { steps: 8 });
  await page.mouse.up();
  const dragged = await page.evaluate(() => ({ x: nodes[0].x, y: nodes[0].y, pinned: nodes[0].pinned, open: panel.classList.contains('open') }));
  assert.ok(Math.abs(dragged.x - node.x - 130) < 1);
  assert.ok(Math.abs(dragged.y - node.y - 45) < 1);
  assert.equal(dragged.pinned, true);
  assert.equal(dragged.open, false, 'drag must not open an article');
  await page.mouse.move(30, 500); await page.mouse.down();
  await page.mouse.move(100, 550, { steps: 5 }); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => [view.x, view.y]), [70, 50]);
  await page.mouse.move(500, 450); await page.mouse.wheel(0, -300);
  await page.waitForFunction(() => view.scale > 1);
  await page.mouse.click(16, 300);
  const same = await page.evaluate(() => [nodes[0].x, nodes[0].y]);
  assert.deepEqual(same, [dragged.x, dragged.y], 'node must not spring back');
  const screen = await page.evaluate(() => ({ x: nodes[0].x * view.scale + view.x, y: nodes[0].y * view.scale + view.y }));
  await page.mouse.click(screen.x, screen.y);
  await page.waitForFunction(() => panel.classList.contains('open'));
  assert.equal(await page.locator('#panelTitle').textContent(), '主题正文');
  assert.equal(await page.locator('#graphControls, #resetView, #legend, .hud-legend').count(), 0);
  assert.deepEqual(errors, []);
});
