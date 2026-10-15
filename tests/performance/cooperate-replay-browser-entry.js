import './frontend-browser-entry.js'
import { createCollaborationAdapter } from '../../simple-mind-map/bin/collabV2/adapter.js'
import { createOutbox } from '../../simple-mind-map/bin/collabV2/outbox.js'

// Controlled room transport forwards actual production MemoryEngine op:event
// and ACK values. It creates neither operation results nor synthetic ACKs.
const sessions = new Set()
async function connectStableV2(mm, data, roomKey, clientId, deliveryMode = 'event-first') {
  const f = window.perfFrontend, handlers = new Map(), co = mm.cooperate
  const session = { roomKey, clientId, ack: [], events: [] }
  const socket = {
    connected: true,
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return this },
    off(event, fn) { handlers.get(event)?.delete(fn); return this },
    emit(event, payload, callback) {
      f.requestMemory('emit', { event, payload }).then(result => {
        const broadcast = () => {
        if (event === 'op' && result.ok && result.operation) {
          session.ack.push({ opId: result.opId, revision: result.serverRevision, duplicate: result.duplicate, clientId: result.operation.clientId })
          sessions.forEach(peer => {
            if (!peer.socket.connected || peer.roomKey !== roomKey) return
            peer.events.push({ opId: result.operation.opId, revision: result.operation.serverRevision, clientId: result.operation.clientId })
            ;(peer.handlers.get('op:event') || []).forEach(fn => fn(result.operation))
            if (deliveryMode === 'duplicates') {
              peer.events.push({ opId: result.operation.opId, revision: result.operation.serverRevision, clientId: result.operation.clientId })
              ;(peer.handlers.get('op:event') || []).forEach(fn => fn(result.operation))
            }
          })
        }
        }
        if (deliveryMode === 'ack-first') { if (callback) callback(result); setTimeout(broadcast, 0) }
        else { broadcast(); if (callback) callback(result) }
      }).catch(error => { if (callback) callback({ ok: false, code: error.code, error: error.message }) })
      return this
    },
    disconnect() { this.connected = false }, connect() { this.connected = true }
  }
  const adapter = createCollaborationAdapter({ socket, clientId, timeoutMs: 4000,
    onRemoteOperation: (op, meta) => co.applyV2RemoteOperation(op, meta) })
  Object.assign(session, { socket, adapter, handlers, co, mm })
  sessions.add(session)
  co.setCollabV2Adapter(adapter)
  co.setHttpCollab({ roomKey, version: 0, nodeCount: Object.keys(mm.renderer.nodeCache).length })
  co.resyncHttpBaseline(mm.renderer.renderTree)
  co.establishV2HistoryBaseline()
  await adapter.connect({ roomKey, userId: 'perf-user', lastServerRevision: 0 })
  return session
}
Object.assign(window.perfFrontend, { connectStableV2, createOutbox })
