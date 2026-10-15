// Shared intended-tree fixtures and the strict E2E oracle for final-build E2E.
//
// The oracle is deliberately strict: it requires unique UIDs, exact parents,
// exact ordered children, and exact persisted business data (arbitrary
// structured fields included). Only explicitly documented transient metadata
// is excluded. A whitelist of "known good fields" would hide silently lost or
// extra data, so instead the oracle compares full key sets and reports any
// unexpected or missing key.
const path = require('node:path')
const repo = path.resolve(__dirname, '../..')

// Transient metadata written by the V2 sequencer (field versions / trace ids).
// Documented as non-business: it records revision metadata, not node content.
const PERSIST_TRANSIENT = ['__fv', 'traceId']
// Genuinely non-business UI state attached to in-memory node data only.
// Narrow by design: layout/floating fields are NOT excluded because they can be
// real saved business fields; this fixture does not exercise them.
// Documented normalization for the browser in-memory model only.
// - isActive/resetRichText: selection/edit UI state
// - descendantCount/childCount: renderer-computed layout metadata, not persisted
// - isFloating/customLeft/customTop: floating layout fields (real saved fields
//   in other products) that this fixture does not exercise, so the oracle
//   explicitly does not cover them. Persisted business data and full structure
//   are still compared exactly.
const MODEL_ONLY_TRANSIENT = ['isActive', 'resetRichText', 'descendantCount', 'childCount', 'subtreeVersion', 'hasMore']
// Renderer-computed defaults that are deterministic from the tree structure.
// They are added to the expected browser projection instead of being ignored.
function computedModelDefaults(row, graph) {
  const stack = [...(graph[row.uid].children || [])]
  let descendants = 0
  while (stack.length) { const next = stack.pop(); descendants += 1; stack.push(...(graph[next].children || [])) }
  return { descendantCount: descendants, childCount: (graph[row.uid].children || []).length }
}
// A key is normalized only when its value is the documented empty default
// (root imgMap={}); any non-empty mapping is preserved and compared.
// Null/undefined saved-position values are normalized away only when they are
// the default (absent) representation; any numeric/non-null value is preserved
// and compared exactly, so a reopen that drops a real position is caught.
const NULLABLE_POSITION_KEYS = ['customLeft', 'customTop']
function normalizeEmptyDefaults(data) {
  const out = { ...data }
  if (out.imgMap && typeof out.imgMap === 'object' && Object.keys(out.imgMap).length === 0) delete out.imgMap
  for (const key of NULLABLE_POSITION_KEYS) if (out[key] === null || out[key] === undefined) delete out[key]
  return out
}

// Canonical JSON stringify: object key order is not business data, so compare
// structurally equivalent objects as equal while still catching value/type
// changes. Array order is preserved.
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function buildSmallGraph(branches = 4, leaves = 5) {
  const graph = {
    root: { isRoot: true, data: { uid: 'root', text: '<p>Root <strong>rich</strong> text</p>', richText: true, expand: true, customMeta: { kind: 'root', flag: 'keep' } }, children: [] }
  }
  for (let i = 0; i < branches; i++) {
    const branch = 'branch-' + i
    graph.root.children.push(branch)
    graph[branch] = { data: { uid: branch, text: '<p>Branch ' + i + '</p>', richText: true, expand: true }, children: [] }
    for (let j = 0; j < leaves; j++) {
      const uid = `leaf-${i}-${j}`
      graph[branch].children.push(uid)
      const data = { uid, text: `<p>Leaf <em>${i}-${j}</em></p>`, richText: true, expand: true, customMeta: { kind: 'leaf', i, j } }
      // One node carries a real non-null saved position so fresh/cold reopen is
      // checked for position loss (not confusable with the move target).
      if (i === 2 && j === 4) { data.isFloating = true; data.customLeft = 120; data.customTop = 48 }
      graph[uid] = { data, children: [] }
    }
  }
  return graph
}

function buildLargeGraph(total = 10000) {
  const graph = require(path.join(repo, 'simple-mind-map/test/fixtures/largeMapFixtures')).bushObjectGraph(total, 'e2e-')
  Object.values(graph).forEach((node, index) => {
    node.data.text = '<p>' + String(node.data.text) + '</p>'
    node.data.richText = true
    node.data.expand = true
    if (index === 0) node.data.customMeta = { kind: 'large-root' }
  })
  graph.root.data.text = '<p>Large <strong>root</strong></p>'
  return graph
}

function stripTransient(data, transient) {
  const out = normalizeEmptyDefaults(data || {})
  for (const key of transient) delete out[key]
  return out
}

// Deterministic expected projection: one row per node, parent-before-child,
// child-array order, full structured data with documented transient keys removed.
function canonicalGraph(graph, options = {}) {
  const transient = options.transient || PERSIST_TRANSIENT
  const rows = []
  const visit = (uid, parentUid) => {
    const node = graph[uid]
    let data = stripTransient(node.data, transient)
    // Leaf expand has no expand semantics; non-leaf expand is a real branch
    // state and is preserved (must match the EXPAND_ALL expectation).
    if (options.browserLeafExpand && !(node.children || []).length) delete data.expand
    rows.push({ uid, parentUid, children: (node.children || []).slice(), data })
    for (const child of node.children || []) visit(child, uid)
  }
  visit('root', null)
  return rows
}

// Read-only canonical projection of actual PG rows. Rows arrive ordered by
// position; ordered children are derived from that order and the DFS traversal
// is deterministic from the root. No field is synthesized or dropped.
function projectRawRows(rows, transient = PERSIST_TRANSIENT) {
  const active = rows.filter(row => !row.deleted_at)
  const byUid = new Map(active.map(row => [row.uid, row]))
  const groups = new Map()
  for (const row of active) {
    if (!groups.has(row.parent_uid)) groups.set(row.parent_uid, [])
    groups.get(row.parent_uid).push(row.uid)
  }
  const root = active.find(row => row.is_root) || active.find(row => row.parent_uid == null)
  const out = []
  const visit = (uid, parentUid) => {
    const row = byUid.get(uid)
    if (!row) return
    out.push({ uid, parentUid, children: (groups.get(uid) || []).slice(), data: stripTransient(row.data, transient) })
    for (const child of groups.get(uid) || []) visit(child, uid)
  }
  if (root) visit(root.uid, null)
  return out
}

// Integrity lint for raw active PG rows: exactly one root, unique active UIDs,
// existing parents, no duplicate/equal-position siblings, and every active row
// reachable from the root (no orphan or second-root rows silently ignored by a
// root-only projection).
function rawIntegrityProblems(rows) {
  const problems = []
  const active = rows.filter(row => !row.deleted_at)
  const roots = active.filter(row => row.is_root)
  if (roots.length !== 1) problems.push(`raw-integrity: expected exactly one root, found ${roots.length}`)
  const byUid = new Map()
  for (const row of active) {
    if (byUid.has(row.uid)) problems.push(`raw-integrity: duplicate active uid ${row.uid}`)
    byUid.set(row.uid, row)
  }
  const groups = new Map()
  for (const row of active) {
    if (!groups.has(row.parent_uid)) groups.set(row.parent_uid, [])
    groups.get(row.parent_uid).push(row)
  }
  for (const [parentUid, list] of groups) {
    if (parentUid != null && !byUid.has(parentUid)) problems.push(`raw-integrity: missing parent ${parentUid}`)
    const uidSet = new Set(list.map(row => row.uid))
    if (uidSet.size !== list.length) problems.push(`raw-integrity: duplicate child under ${parentUid}`)
    const positions = list.map(row => row.position).filter(value => value != null)
    if (new Set(positions).size !== positions.length) problems.push(`raw-integrity: duplicate sibling position under ${parentUid}`)
  }
  const reachable = new Set()
  const visit = uid => { if (reachable.has(uid)) return; reachable.add(uid); for (const row of groups.get(uid) || []) visit(row.uid) }
  if (roots.length === 1) visit(roots[0].uid)
  const orphans = active.map(row => row.uid).filter(uid => !reachable.has(uid))
  if (orphans.length) problems.push(`raw-integrity: unreachable active rows ${orphans.slice(0, 10).join(',')}`)
  if (reachable.size !== active.length) problems.push(`raw-integrity: reachable ${reachable.size} != active ${active.length}`)
  return problems
}

// Projection of live browser rows ({uid,parentUid,children,data}).
function projectBrowserModel(rows, transient = MODEL_ONLY_TRANSIENT.concat(PERSIST_TRANSIENT)) {
  return rows.map(row => {
    const data = stripTransient(row.data, transient)
    const isLeaf = !(row.children && row.children.length) && !row.data.hasMore
    if (isLeaf) delete data.expand
    return { uid: row.uid, parentUid: row.parentUid, children: (row.children || []).slice(), data }
  })
}

// Strict comparator. Returns a list of human-readable problems; empty means the
// actual projection exactly matches the independent expected projection.
function compareCanonical(expected, actual, label) {
  const problems = []
  const seen = new Set()
  for (const row of actual) {
    if (seen.has(row.uid)) problems.push(`${label}: duplicate uid ${row.uid}`)
    seen.add(row.uid)
  }
  const expectedUids = expected.map(row => row.uid)
  const actualUids = actual.map(row => row.uid)
  if (expectedUids.join(',') !== actualUids.join(',')) {
    problems.push(`${label}: ordered UID sequence differs (expected ${expectedUids.length}, actual ${actualUids.length})`)
    const missing = expectedUids.filter(uid => !seen.has(uid))
    const extra = actualUids.filter(uid => !expectedUids.includes(uid))
    if (missing.length) problems.push(`${label}: missing uids ${missing.slice(0, 10).join(',')}`)
    if (extra.length) problems.push(`${label}: unexpected uids ${extra.slice(0, 10).join(',')}`)
  }
  const byUid = new Map(actual.map(row => [row.uid, row]))
  for (const row of expected) {
    const found = byUid.get(row.uid)
    if (!found) continue
    if (found.parentUid !== row.parentUid) problems.push(`${label}: ${row.uid} parent expected ${row.parentUid} actual ${found.parentUid}`)
    if (stableStringify(found.children) !== stableStringify(row.children)) {
      problems.push(`${label}: ${row.uid} children order expected [${row.children.join(',')}] actual [${(found.children || []).join(',')}]`)
    }
    const expectedKeys = Object.keys(row.data).sort()
    const actualKeys = Object.keys(found.data).sort()
    for (const key of expectedKeys) if (!actualKeys.includes(key)) problems.push(`${label}: ${row.uid} missing field ${key}`)
    for (const key of actualKeys) if (!expectedKeys.includes(key)) problems.push(`${label}: ${row.uid} unexpected field ${key}=${stableStringify(found.data[key])}`)
    for (const key of expectedKeys) {
      if (!actualKeys.includes(key)) continue
      if (stableStringify(row.data[key]) !== stableStringify(found.data[key])) {
        problems.push(`${label}: ${row.uid}.${key} expected ${stableStringify(row.data[key])} actual ${stableStringify(found.data[key])}`)
      }
    }
  }
  return problems
}

// Fixture-level negative selftest: the comparator must reject dropped,
// reordered, duplicated nodes and a changed unknown custom field. This is test
// infrastructure validation, not a product assertion.
function selfTest() {
  const graph = buildSmallGraph(2, 2)
  const expected = canonicalGraph(graph)
  const cases = []
  const mutate = fn => { const clone = JSON.parse(JSON.stringify(expected)); fn(clone); return compareCanonical(expected, clone, 'negative').length }
  cases.push({ name: 'rejects-dropped-node', rejected: mutate(rows => { rows.splice(rows.findIndex(r => r.uid === 'leaf-0-0'), 1) }) > 0 })
  cases.push({ name: 'rejects-reordered-children', rejected: mutate(rows => { const r = rows.find(x => x.uid === 'root'); r.children = r.children.slice().reverse() }) > 0 })
  cases.push({ name: 'rejects-duplicate-uid', rejected: mutate(rows => { rows.push(JSON.parse(JSON.stringify(rows[1]))) }) > 0 })
  cases.push({ name: 'rejects-changed-unknown-field', rejected: mutate(rows => { rows.find(x => x.uid === 'leaf-1-1').data.customMeta = { kind: 'tampered' } }) > 0 })
  cases.push({ name: 'rejects-extra-field', rejected: mutate(rows => { rows.find(x => x.uid === 'root').data.sneaky = 1 }) > 0 })
  cases.push({ name: 'rejects-unexpected-nonnull-position', rejected: mutate(rows => { rows.find(x => x.uid === 'leaf-0-0').data.customLeft = 99 }) > 0 })
  {
    const positioned = JSON.parse(JSON.stringify(graph))
    positioned['leaf-0-0'].data.customLeft = 55
    positioned['leaf-0-0'].data.customTop = 66
    const positionedExpected = canonicalGraph(positioned)
    const dropped = JSON.parse(JSON.stringify(positionedExpected))
    delete dropped.find(x => x.uid === 'leaf-0-0').data.customLeft
    cases.push({ name: 'rejects-dropped-expected-position', rejected: compareCanonical(positionedExpected, dropped, 'negative').length > 0 })
    cases.push({ name: 'accepts-identical-position', rejected: compareCanonical(positionedExpected, JSON.parse(JSON.stringify(positionedExpected)), 'negative').length === 0 })
  }
  cases.push({ name: 'accepts-identical', rejected: compareCanonical(expected, JSON.parse(JSON.stringify(expected)), 'negative').length === 0 })
  {
    const g = buildSmallGraph(2, 2)
    const browserExpected = canonicalGraph(g, { browserLeafExpand: true })
    const toRows = graph => {
      const rows = []
      const visit = (uid, parentUid) => {
        const node = graph[uid]
        rows.push({ uid, parentUid, children: (node.children || []).slice(), data: { ...node.data } })
        for (const c of node.children || []) visit(c, uid)
      }
      visit('root', null)
      return rows
    }
    const nonLeafRows = toRows(g)
    nonLeafRows.find(r => r.uid === 'branch-0').data.expand = false
    cases.push({ name: 'rejects-nonleaf-expand-change', rejected: compareCanonical(browserExpected, projectBrowserModel(nonLeafRows), 'negative').length > 0 })
    const leafRows = toRows(g)
    leafRows.find(r => r.uid === 'leaf-0-0').data.expand = false
    cases.push({ name: 'normalizes-leaf-expand', rejected: compareCanonical(browserExpected, projectBrowserModel(leafRows), 'negative').length === 0 })
  }
  return cases
}

module.exports = { buildSmallGraph, buildLargeGraph, canonicalGraph, projectRawRows, projectBrowserModel, compareCanonical, selfTest, stripTransient, stableStringify, rawIntegrityProblems, normalizeEmptyDefaults, PERSIST_TRANSIENT, MODEL_ONLY_TRANSIENT }
