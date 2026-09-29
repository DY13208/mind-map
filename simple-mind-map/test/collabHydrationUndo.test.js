const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/plugins/Cooperate.js'), 'utf8')

function loadMethod(name, next) {
  const start = source.indexOf(`  async ${name}(`)
  const end = source.indexOf(`\n  async ${next}(`, start)
  assert.ok(start >= 0 && end > start, `${name} source found`)
  const declaration = source.slice(start, end).trim().replace(/^async /, 'async function ')
  return vm.runInNewContext(`(${declaration})`, { console, Promise, Date, Map, Set, Number, Array, Error })
}

const hydrateFromHttp = loadMethod('hydrateFromHttp', 'hydrateNodeData')
const hydrateExpandedPartialParents = loadMethod('hydrateExpandedPartialParents', 'ensurePlacementParent')

function fixture({ uid = 'parent', count, children = [], responses }) {
  const data = { data: { uid, childCount: count, subtreeVersion: 1 }, children: children.slice() }
  const node = { nodeData: data, children: [], getData(key) { return data.data[key] } }
  const calls = []
  let renders = 0
  const context = {
    httpFetchSubtree: async (id, options) => {
      calls.push({ id, ...options })
      return responses[calls.length - 1] || responses[responses.length - 1]
    },
    httpFetchDeepSubtree: null,
    dirtySubtrees: new Map(),
    hydrateFailedUids: new Set(),
    hydratedUids: new Set(),
    hydrateInflight: new Map(),
    mergeHttpChildren(parent, incoming) {
      const have = new Set(parent.children.map(child => child.data.uid))
      for (const child of incoming || []) {
        if (!have.has(child.data.uid)) parent.children.push(child)
      }
    },
    flushPendingHttpRefresh() {},
    nodeNeedsHydrate(current) {
      return current.nodeData.children.length < current.nodeData.data.childCount
    },
    hydrateFromHttp,
    mindMap: { renderer: { root: node }, render() { renders += 1 } }
  }
  return { context, data, node, calls, get renders() { return renders } }
}

;(async () => {
  // Undoing a sole child must accept the server's zero, not retain stale 1.
  const empty = fixture({ count: 1, responses: [{ total: 0, children: [], version: 2 }] })
  assert.equal(await hydrateFromHttp.call(empty.context, empty.node), true)
  assert.equal(empty.data.data.childCount, 0)
  assert.equal(empty.context.hydrateFailedUids.has('parent'), false)
  assert.equal(empty.calls.length, 1)

  // Older subtree payloads may omit total: do not mistake that for zero.
  const legacy = fixture({ count: 3, responses: [{ children: [], version: 2 }] })
  assert.equal(await hydrateFromHttp.call(legacy.context, legacy.node), false)
  assert.equal(legacy.data.data.childCount, 3)
  assert.equal(legacy.context.hydrateFailedUids.has('parent'), true)

  // A stale/tombstoned child can make a response incomplete. It must not
  // trigger another whole-tree render and request on every render_end.
  const existing = { data: { uid: 'child' }, children: [] }
  const stuck = fixture({
    count: 2,
    children: [existing],
    responses: [{ total: 2, children: [existing], version: 2 }]
  })
  assert.equal(await hydrateExpandedPartialParents.call(stuck.context).then(r => r.changed), false)
  assert.equal(stuck.renders, 0)
  assert.equal(stuck.context.hydrateFailedUids.has('parent'), true)
  assert.equal((await hydrateExpandedPartialParents.call(stuck.context)).hydrated, 0)
  assert.equal(stuck.calls.length, 1)

  // Historical wide parents (>200 direct children) require all pages before
  // being considered complete; an actual merge renders exactly once.
  const rows = Array.from({ length: 250 }, (_, i) => ({ data: { uid: `n${i}` }, children: [] }))
  const wide = fixture({
    count: 250,
    responses: [
      { total: 250, offset: 0, has_more: true, children: rows.slice(0, 200), version: 3 },
      { total: 250, offset: 200, has_more: false, children: rows.slice(200), version: 3 }
    ]
  })
  assert.equal((await hydrateExpandedPartialParents.call(wide.context)).changed, true)
  assert.equal(wide.data.children.length, 250)
  assert.equal(wide.calls[1].offset, 200)
  assert.equal(wide.renders, 1)

  const legacyWide = fixture({
    count: 250,
    responses: [
      { total: 250, offset: 0, has_more: true, children: rows.slice(0, 200) },
      { total: 250, offset: 200, has_more: false, children: rows.slice(200) }
    ]
  })
  assert.equal(await hydrateFromHttp.call(legacyWide.context, legacyWide.node), true)
  assert.equal(legacyWide.data.children.length, 250)
  assert.equal((await hydrateExpandedPartialParents.call(wide.context)).hydrated, 0)
  assert.equal(wide.renders, 1)

  console.log('collab hydration undo tests passed')
})().catch(err => {
  console.error(err)
  process.exitCode = 1
})
