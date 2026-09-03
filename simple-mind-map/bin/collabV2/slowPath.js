const mindDoc = require('../mindDoc')

const SLOW_PATH_TYPES = new Set(['map.replace'])

function shouldLogSlowPath() {
  const raw = process.env.COLLAB_SLOW_PATH
  if (raw == null || raw === '') return true
  return !/^(0|false|off|no)$/i.test(String(raw))
}

function logSlowPath(info) {
  if (!shouldLogSlowPath()) return
  console.warn('[COLLAB_SLOW_PATH]', {
    room: info.roomKey,
    operation: info.type,
    reason: info.reason,
    nodeCount: info.nodeCount,
    durationMs: info.durationMs
  })
}

function applyMapReplace(nodes, op, command) {
  const started = process.hrtime.bigint()
  const previous = nodes || {}
  const next =
    (op.payload && op.payload.nodes) ||
    mindDoc.treeToObject(op.payload && op.payload.tree) ||
    nodes ||
    {}
  const count = Object.keys(next).length
  logSlowPath({
    roomKey: op.roomKey || (command && command.mapId),
    type: 'map.replace',
    reason: 'bulk_replace',
    nodeCount: count,
    durationMs: Number(process.hrtime.bigint() - started) / 1e6
  })
  return {
    nodes: next,
    result: { nodeCount: count },
    event: {
      type: 'map.replaced',
      payload: { resnapshot: true, nodeCount: count },
      affectedUids: ['root']
    },
    inversePayload: {
      type: 'map.replace',
      payload: { nodes: previous }
    },
    slowPath: true,
    slowPathAllowed: true
  }
}

function isSlowPathType(type) {
  return SLOW_PATH_TYPES.has(String(type || ''))
}

function unsupportedOperation(type, roomKey) {
  logSlowPath({
    roomKey,
    type,
    reason: 'unsupported_no_fallback',
    nodeCount: 0,
    durationMs: 0
  })
  const err = new Error('不支持的操作类型: ' + (type || ''))
  err.code = 'UNSUPPORTED_OPERATION'
  err.statusCode = 400
  return err
}

module.exports = {
  SLOW_PATH_TYPES,
  isSlowPathType,
  applyMapReplace,
  logSlowPath,
  unsupportedOperation
}
