'use strict'

const { commandError } = require('./conflictErrors')
const {
  subtreeTokensFromRows,
  readSubtreeRowsForRoots
} = require('./subtreeToken')
const { PRECONDITION_UNSUPPORTED } = require('./nodeUpdateExpected')

function unsupported(message) {
  return commandError(message, PRECONDITION_UNSUPPORTED, 503)
}

function operationList(command) {
  if (command && command.type === 'node.batch') {
    return Array.isArray(command.payload && command.payload.ops)
      ? command.payload.ops
      : []
  }
  return command ? [command] : []
}

function buildGraphIndex(nodes = {}) {
  const parentOf = new Map()
  const childrenByParent = new Map()
  Object.keys(nodes || {}).forEach(parentUid => {
    const children = ((nodes[parentUid] && nodes[parentUid].children) || []).map(String)
    childrenByParent.set(String(parentUid), children)
    children.forEach(uid => {
      parentOf.set(uid, String(parentUid))
    })
  })
  return { parentOf, childrenByParent }
}

function graphBaseline(nodes = {}, index = buildGraphIndex(nodes)) {
  const rows = new Map()
  Object.keys(nodes || {}).forEach(uid => {
    const node = nodes[uid] || {}
    rows.set(String(uid), {
      uid: String(uid),
      parent_uid: index.parentOf.get(String(uid)) || null,
      position: String(node.position || ''),
      node_version: 0,
      data: { ...(node.data || {}), uid: String(uid) }
    })
  })
  return rows
}

function graphSubtreeLocations(nodes, rootUid, index = buildGraphIndex(nodes)) {
  const root = String(rootUid || '')
  if (!root || !nodes || !nodes[root]) return null
  const rows = []
  const stack = [root]
  const seen = new Set()
  while (stack.length) {
    const uid = String(stack.pop())
    if (seen.has(uid)) throw unsupported('当前节点关系无法安全核对子树校验值')
    seen.add(uid)
    const node = nodes[uid]
    if (!node) throw unsupported('当前节点快照不完整，无法核对子树校验值')
    rows.push({
      uid,
      parent_uid: index.parentOf.get(uid) || null,
      position: String(node.position || '')
    })
    ;(index.childrenByParent.get(uid) || []).forEach(child => stack.push(child))
  }
  return rows
}

function graphSubtreeLocationsForRoots(nodes, rootUids, index = buildGraphIndex(nodes)) {
  const rowsByUid = new Map()
  for (const rootUid of rootUids || []) {
    const root = String(rootUid || '')
    if (!root || !nodes || !nodes[root]) {
      throw unsupported('当前节点快照不完整，无法核对子树校验值')
    }
    const stack = [root]
    const seenForRoot = new Set()
    while (stack.length) {
      const uid = String(stack.pop())
      if (seenForRoot.has(uid)) throw unsupported('当前节点关系无法安全核对子树校验值')
      seenForRoot.add(uid)
      const node = nodes[uid]
      if (!node) throw unsupported('当前节点快照不完整，无法核对子树校验值')
      if (rowsByUid.has(uid)) continue
      rowsByUid.set(uid, {
        uid,
        parent_uid: index.parentOf.get(uid) || null,
        position: String(node.position || '')
      })
      ;(index.childrenByParent.get(uid) || []).forEach(child => stack.push(child))
    }
  }
  return Array.from(rowsByUid.values())
}

function assertSameSubtreeShape(graphRows, dbRows) {
  const graph = new Map((graphRows || []).map(row => [String(row.uid), row]))
  const db = new Map((dbRows || []).map(row => [String(row.uid), row]))
  if (!graph.size || graph.size !== db.size) {
    throw unsupported('房间快照与节点索引不一致，无法安全校验删除')
  }
  for (const [uid, row] of graph) {
    const dbRow = db.get(uid)
    if (!dbRow || String(row.parent_uid || '') !== String(dbRow.parent_uid || '')) {
      throw unsupported('房间快照与节点索引不一致，无法安全校验删除')
    }
    if (String(row.position || '') !== String(dbRow.position || '')) {
      throw unsupported('房间快照与节点索引不一致，无法安全校验删除')
    }
  }
}

async function readLegacyPreconditionBaseline(client, roomKey, command, nodes = {}) {
  const graphIndex = buildGraphIndex(nodes)
  const baselineNodes = graphBaseline(nodes, graphIndex)
  const subtreeTokens = new Map()
  const deletions = operationList(command).filter(item => item && item.type === 'node.delete')
  if (!deletions.length) return { nodes: baselineNodes, subtreeTokens }
  if (!client || typeof client.query !== 'function') {
    throw unsupported('当前兼容写入路径无法计算删除子树校验值')
  }
  const deleteUids = Array.from(new Set(deletions
    .map(op => String((op.payload && op.payload.uid) || '').trim())
    .filter(Boolean)))
  if (!deleteUids.length) return { nodes: baselineNodes, subtreeTokens }
  let rows
  try {
    rows = await readSubtreeRowsForRoots(client, roomKey, deleteUids)
  } catch (err) {
    if (err && ['42P01', '42703'].includes(String(err.code))) {
      throw unsupported('当前兼容写入路径没有可用的 node_version 索引，无法安全校验删除')
    }
    throw err
  }
  if (!rows.length || rows.some(row => row.cycle)) {
    throw unsupported('当前兼容写入路径无法读取完整删除子树')
  }
  const graphRows = graphSubtreeLocationsForRoots(nodes, deleteUids, graphIndex)
  assertSameSubtreeShape(graphRows, rows)
  const batchTokens = subtreeTokensFromRows(rows, deleteUids)
  deleteUids.forEach(uid => subtreeTokens.set(uid, batchTokens.get(uid)))
  return { nodes: baselineNodes, subtreeTokens }
}

module.exports = {
  operationList,
  buildGraphIndex,
  graphBaseline,
  graphSubtreeLocations,
  graphSubtreeLocationsForRoots,
  assertSameSubtreeShape,
  readLegacyPreconditionBaseline
}
