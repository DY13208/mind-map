'use strict'
const { createEngine } = require('../../simple-mind-map/bin/collabV2/engine')

// HTTP is the controlled transport boundary. Mutations, revision assignment,
// inverses, tombstones and undo below execute the production V2 memory engine.
function createMemoryTransport() {
  const engine = createEngine()
  const access = { userId: 'perf-user', role: 'owner', canEdit: true, canView: true }
  function seedTree(tree) {
    const graph = {}
    const visit = (node, root = false) => {
      graph[node.data.uid] = { isRoot: root, data: structuredClone(node.data), children: (node.children || []).map(child => child.data.uid) }
      ;(node.children || []).forEach(child => visit(child))
    }
    visit(tree, true)
    return graph
  }
  return function handleRequest(req, res) {
    const pathname = String(req.url).split('?')[0]
    if (!pathname.startsWith('/perf-memory/')) return false
    let body = ''
    req.on('data', part => { body += part })
    req.on('end', async () => {
      const reply = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
      try {
        const input = body ? JSON.parse(body) : {}
        if (pathname === '/perf-memory/seed') {
          engine.replaceNodes(input.roomKey, seedTree(input.tree)); reply({ ok: true }); return
        }
        if (pathname === '/perf-memory/state') {
          const room = engine.getRoom(input.roomKey); reply({ ok: true, nodes: room.nodes, revision: room.revision, operations: room.ops }); return
        }
        const { event, payload } = input
        if (event === 'join') {
          const room = engine.getRoom(payload.roomKey)
          reply({ ok: true, canEdit: true, canView: true, role: 'owner', peers: [], serverRevision: room.revision,
            sync: engine.opsAfter(payload.roomKey, payload.lastServerRevision) }); return
        }
        if (event === 'sync') { reply({ ok: true, ...engine.opsAfter(payload.roomKey, payload.afterRevision, payload.limit) }); return }
        if (event === 'op') {
          const result = await engine.submit({ ...payload, userId: access.userId }, access)
          reply({ ok: true, operation: result.operation, opId: result.operation.opId,
            serverRevision: result.operation.serverRevision, duplicate: result.duplicate }); return
        }
        reply({ ok: true })
      } catch (error) { reply({ ok: false, code: error.code || 'TEST_TRANSPORT_ERROR', error: error.message }) }
    })
    return true
  }
}
module.exports = { createMemoryTransport }
