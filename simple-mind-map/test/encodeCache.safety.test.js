'use strict'

/**
 * Encoded-rows cache must stay internal/transient:
 * - never leak into API / PG / legacy JSON / history / hash / collab payloads
 * - never reuse after business mutation of the canonical graph
 */

const assert = require('assert')
const {
  canonicalizeNodes,
  snapshotCanonicalForStorage,
  encodeNodeRows,
  canonicalTreeHash,
  structureSignature
} = require('../bin/roomNodes')
const { historyChecksum, toBusinessTree } = require('../bin/collabHistory/canonical')
const { bushObjectGraph } = require('./fixtures/largeMapFixtures')

function deepHasKey(value, key, path = '') {
  if (value == null) return null
  if (typeof value !== 'object') return null
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return path ? path + '.' + key : key
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = deepHasKey(value[i], key, path + '[' + i + ']')
      if (hit) return hit
    }
    return null
  }
  const keys = Object.keys(value)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const hit = deepHasKey(value[k], key, path ? path + '.' + k : k)
    if (hit) return hit
  }
  return null
}

function assertNoEncodedRowsLeak(label, value) {
  const json = JSON.stringify(value)
  assert.ok(
    !json.includes('__encodedRows'),
    label + ': JSON leak of __encodedRows'
  )
  const hit = deepHasKey(value, '__encodedRows')
  assert.strictEqual(hit, null, label + ': enumerable __encodedRows at ' + hit)
}

;(async () => {
  let leak = 'PASS'
  let stale = 'PASS'

  try {
    const graph = bushObjectGraph(200)
    const snap = snapshotCanonicalForStorage(graph)
    assert.ok(snap.ok)
    assert.ok(Array.isArray(snap.encodedRows))
    assert.strictEqual(snap.encodedRows.length, 200)

    // Encoded rows are returned separately, never cached on a mutable graph.
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(snap.nodes, '__encodedRows'),
      false
    )
    assert.ok(snap.encodedRows)

    // 1) API tree / export-shaped JSON
    const apiTree = JSON.parse(JSON.stringify(snap.nodes))
    assertNoEncodedRowsLeak('API tree', apiTree)

    // 2) room_nodes row.data payloads
    for (const row of snap.encodedRows) {
      assertNoEncodedRowsLeak('room_nodes.data:' + row.uid, row.data)
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(row, '__encodedRows'),
        false
      )
    }

    // 3) rooms.nodes legacy mirror
    const legacyMirror = JSON.parse(JSON.stringify(snap.nodes))
    assertNoEncodedRowsLeak('rooms.nodes', legacyMirror)

    // 4) History checkpoint / version tree
    const business = toBusinessTree(snap.nodes)
    assertNoEncodedRowsLeak('history business tree', business)
    const checkpoint = {
      tree_snapshot: business,
      metadata_snapshot: { layout: 'logicalStructure' }
    }
    assertNoEncodedRowsLeak('checkpoint', checkpoint)

    // 5) hash / checksum inputs
    const hash = canonicalTreeHash(snap.nodes)
    assert.ok(typeof hash === 'string' && hash.length > 8)
    const sig = structureSignature(snap.nodes)
    assert.ok(sig)
    const checksum = historyChecksum(snap.nodes, {})
    assert.ok(typeof checksum === 'string' && checksum.length === 64)
    assert.ok(!String(hash).includes('__encodedRows'))
    assert.ok(!String(sig).includes('__encodedRows'))

    // 6) Collaboration-shaped payload
    const collabPayload = {
      type: 'map.replace',
      tree: apiTree,
      allowFullTree: true,
      source: 'encode-cache-safety'
    }
    assertNoEncodedRowsLeak('collab payload', collabPayload)

    // Legacy __encodedRows prop must be stripped and never trusted blindly.
    const legacyGraph = bushObjectGraph(50)
    const rows = encodeNodeRows(legacyGraph)
    Object.defineProperty(legacyGraph, '__encodedRows', {
      value: rows,
      enumerable: true,
      configurable: true
    })
    canonicalizeNodes(legacyGraph)
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(legacyGraph, '__encodedRows'),
      false
    )
  } catch (err) {
    leak = 'FAIL'
    console.error('ENCODE_CACHE_LEAK FAIL', err)
    throw err
  }

  try {
    const graph = bushObjectGraph(120)
    const snap = snapshotCanonicalForStorage(graph)
    assert.ok(snap.ok)
    const victim = Object.keys(snap.nodes).find(uid => uid !== 'root')
    // Same-length edits defeated the former fingerprint. No graph cache remains.
    const previousText = snap.nodes[victim].data.text
    snap.nodes[victim].data.text = 'X'.repeat(previousText.length)
    const updated = snapshotCanonicalForStorage(snap.nodes)
    assert.strictEqual(updated.encodedRows.find(r => r.uid === victim).data.text,
      snap.nodes[victim].data.text)

    // Fresh snapshot after mutation encodes new text
    snap.nodes[victim].data.text = 'AFTER_MUTATION_OK'
    const fresh = snapshotCanonicalForStorage(snap.nodes)
    assert.ok(fresh.ok)
    const freshRows = fresh.encodedRows
    assert.ok(freshRows)
    const hit = freshRows.find(r => r.uid === victim)
    assert.ok(hit)
    assert.strictEqual(hit.data.text, 'AFTER_MUTATION_OK')
  } catch (err) {
    stale = 'FAIL'
    console.error('ENCODE_CACHE_STALE_REUSE FAIL', err)
    throw err
  }

  console.log('ENCODE_CACHE_LEAK =', leak)
  console.log('ENCODE_CACHE_STALE_REUSE =', stale)
  assert.strictEqual(leak, 'PASS')
  assert.strictEqual(stale, 'PASS')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
