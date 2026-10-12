import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const appA = process.env.MCP_BASELINE_APP_A || 'http://127.0.0.1:19090'
export const appB = process.env.MCP_BASELINE_APP_B || 'http://127.0.0.1:19091'
export const token = process.env.MCP_BASELINE_MCP_TOKEN || 'mcp-incremental-test-only-token-0160b5a7'

export async function api(base, pathname, options = {}) {
  const headers = new Headers(options.headers || {})
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(new URL(pathname, `${base}/`), { ...options, headers })
  const text = await response.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch (_) {}
  return { response, data, text }
}

export function makeTree(kind, prefix = 'fixture') {
  if (kind === '6001') {
    const children = []
    for (let branch = 0; branch < 20; branch++) {
      const branchUid = `${prefix}-branch-${String(branch).padStart(2, '0')}`
      const leaves = []
      for (let leaf = 0; leaf < 299; leaf++) {
        leaves.push({
          data: { uid: `${prefix}-leaf-${String(branch).padStart(2, '0')}-${String(leaf).padStart(3, '0')}`, text: `Leaf ${branch + 1}-${leaf + 1}` },
          children: []
        })
      }
      children.push({
        data: { uid: branchUid, text: `Branch ${branch + 1}`, expand: false },
        children: leaves
      })
    }
    return {
      data: { uid: 'root', text: `Baseline root ${prefix}`, expand: true },
      children
    }
  }

  if (kind === 'deep') {
    let tree = { data: { uid: `${prefix}-deep-079`, text: 'Deep 80' }, children: [] }
    for (let depth = 78; depth >= 0; depth--) {
      tree = {
        data: { uid: depth === 0 ? 'root' : `${prefix}-deep-${String(depth).padStart(3, '0')}`, text: depth === 0 ? `Deep root ${prefix}` : `Deep ${depth}` },
        children: [tree]
      }
    }
    return tree
  }

  if (kind === 'wide') {
    return {
      data: { uid: 'root', text: `Wide root ${prefix}`, expand: true },
      children: Array.from({ length: 600 }, (_, index) => ({
        data: { uid: `${prefix}-wide-${String(index).padStart(3, '0')}`, text: `Wide ${index + 1}` },
        children: []
      }))
    }
  }

  if (kind === 'long-text') {
    return {
      data: { uid: 'root', text: `Long text root ${prefix}`, expand: true },
      children: [{
        data: { uid: `${prefix}-long-text`, text: `Long text: ${'测'.repeat(20_000)}` },
        children: []
      }]
    }
  }

  if (kind === 'small') {
    return {
      data: { uid: 'root', text: `Root ${prefix}`, expand: true },
      children: [{
        data: { uid: `${prefix}-branch`, text: 'Branch', expand: false },
        children: [{ data: { uid: `${prefix}-leaf`, text: 'Leaf' }, children: [] }]
      }]
    }
  }

  throw new Error(`unknown fixture kind: ${kind}`)
}

export function countTree(tree) {
  let count = 0
  const stack = [tree]
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    count++
    for (const child of node.children || []) stack.push(child)
  }
  return count
}

export async function seedRoom(base, roomKey, kind, options = {}) {
  const tree = options.tree || makeTree(kind, options.prefix || roomKey)
  const expectedCount = countTree(tree)
  const title = options.title || `MCP baseline ${kind}`
  const create = await api(base, '/api/files', {
    method: 'POST',
    body: JSON.stringify({ room_key: roomKey, title })
  })
  assert.ok([200, 201].includes(create.response.status), `create ${roomKey}: ${create.response.status} ${create.text}`)

  const replace = await api(base, `/api/files/${encodeURIComponent(roomKey)}/replace`, {
    method: 'POST',
    body: JSON.stringify({ tree, title, client_id: `mcp-baseline-seed-${randomUUID()}` })
  })
  assert.equal(replace.response.status, 200, `seed ${roomKey}: ${replace.response.status} ${replace.text}`)

  const verify = await api(base, `/api/files/${encodeURIComponent(roomKey)}?format=nodes`)
  assert.equal(verify.response.status, 200, `verify ${roomKey}: ${verify.response.status} ${verify.text.slice(0, 500)}`)
  const nodes = verify.data.nodes
  assert.ok(Array.isArray(nodes), `format=nodes response must be an array: ${JSON.stringify(Object.keys(verify.data))}`)
  assert.equal(nodes.length, expectedCount, `fixture count mismatch for ${roomKey}`)
  return { roomKey, kind, tree, expectedCount, nodes, version: Number(verify.data.version || verify.data.currentRevision || 1) }
}
