const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
async function main() {
  let time = 0
  let flush
  let body
  const mm = new EventEmitter()
  const bus = { $on() {}, $off() {} }
  const source = fs.readFileSync(path.join(__dirname, '../src/utils/performanceDiagnostics.js'), 'utf8')
    .replace(/^import .*\r?\n/gm, '').replace('export function', 'function')
  const start = vm.runInNewContext(`${source}; startPerformanceDiagnostics`, {
    URL, URLSearchParams, Date, Math, Map, Number, JSON,
    window: { location: { search: '?perfDiagnostics=1', href: 'https://example.test/' } },
    performance: { now: () => time },
    getRuntimeConfig: () => ({ collabApi: '' }),
    subscribeCollabPerformance: () => () => {},
    setInterval: fn => { flush = fn; return 1 }, clearInterval() {},
    fetch: async (_, options) => { body = JSON.parse(options.body); return { status: 200 } }
  })
  const stop = start(mm, 'room', bus)
  mm.emit('node_tree_render_start'); time = 80000; mm.emit('node_tree_render_end')
  mm.emit('render_started', { renderId: 1 }); time += 25
  mm.emit('render_complete', { renderId: 0, renderedNodes: 3 })
  time += 25; mm.emit('render_complete', { renderId: 1, renderedNodes: 3 })
  mm.emit('render_started', { renderId: 2 }); mm.emit('render_cancelled')
  time += 10000; mm.emit('render_complete', { renderId: 2, renderedNodes: 3 })
  await flush()
  const renders = body.events.filter(e => e.kind === 'render')
  assert.equal(renders.length, 1)
  assert.equal(renders[0].durationMs, 50)
  stop()
  assert.equal(mm.listenerCount('render_started'), 0)

  const renderSource = fs.readFileSync(path.join(__dirname, '../../simple-mind-map/src/core/render/Render.js'), 'utf8')
  const from = renderSource.indexOf('  waitForRender() {')
  const to = renderSource.indexOf('\n  collectCollapsedFrontier(', from)
  const methods = vm.runInNewContext(`({${renderSource.slice(from, to)}})`, { Promise })
  const events = new EventEmitter()
  let complete
  const owner = { ...methods, mindMap: events, render: callback => { complete = callback } }
  let resolved = false
  const waiting = owner.waitForRender().then(() => { resolved = true })
  await Promise.resolve()
  assert.equal(resolved, false, 'wait is not released by an arbitrary timeout')
  complete(); await waiting
  assert.equal(events.listenerCount('render_cancelled'), 0)
  const cancelled = owner.waitForRender()
  events.emit('render_cancelled'); await cancelled
  assert.equal(events.listenerCount('render_cancelled'), 0)
  console.log('render diagnostics: partial/stale/cancelled cycles excluded; expansion waits for completion')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
