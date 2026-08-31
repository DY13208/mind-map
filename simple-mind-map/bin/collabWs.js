const encoding = require('lib0/dist/encoding.cjs')
const decoding = require('lib0/dist/decoding.cjs')
const syncProtocol = require('y-protocols/dist/sync.cjs')
const awarenessProtocol = require('y-protocols/dist/awareness.cjs')
const { getYDoc, docs } = require('y-websocket/bin/utils')
const { queueSave, scheduleIdleEvict, cancelIdleEvict } = require('./storage')

const messageSync = 0
const messageAwareness = 1
const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1
const PING_MS = 120000

function send(doc, conn, payload) {
  if (
    conn.readyState !== wsReadyStateConnecting &&
    conn.readyState !== wsReadyStateOpen
  ) {
    closeConn(doc, conn)
    return
  }
  try {
    conn.send(payload, err => {
      if (err != null) closeConn(doc, conn)
    })
  } catch (e) {
    closeConn(doc, conn)
  }
}

function closeConn(doc, conn) {
  if (!doc.conns.has(conn)) {
    try {
      conn.close()
    } catch (e) {
      // ignore
    }
    return
  }
  const controlledIds = doc.conns.get(conn)
  doc.conns.delete(conn)
  awarenessProtocol.removeAwarenessStates(
    doc.awareness,
    Array.from(controlledIds || []),
    null
  )
  if (doc.conns.size === 0) {
    // 大图断线时不要立刻 destroy：encode/销毁/再从 COS 灌回会再吃一份内存。
    queueSave(doc.name, doc).catch(err => {
      console.error('[persist] disconnect save failed', doc.name, err.message)
    })
    scheduleIdleEvict(doc.name)
  }
  try {
    conn.close()
  } catch (e) {
    // ignore
  }
}

function onMessage(conn, doc, message) {
  try {
    const encoder = encoding.createEncoder()
    const decoder = decoding.createDecoder(message)
    const messageType = decoding.readVarUint(decoder)
    switch (messageType) {
      case messageSync:
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder))
        }
        break
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        )
        break
      }
    }
  } catch (err) {
    console.error(err)
    doc.emit('error', [err])
  }
}

function setupWSConnection(conn, req, { docName, gc = true } = {}) {
  const name =
    docName ||
    decodeURIComponent((req.url || '/').slice(1).split('?')[0] || 'default')
  conn.binaryType = 'arraybuffer'
  const doc = getYDoc(name, gc)
  cancelIdleEvict(name)
  doc.conns.set(conn, new Set())
  conn.on('message', message => onMessage(conn, doc, new Uint8Array(message)))

  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) closeConn(doc, conn)
      clearInterval(pingInterval)
      return
    }
    if (!doc.conns.has(conn)) {
      clearInterval(pingInterval)
      return
    }
    pongReceived = false
    try {
      conn.ping()
    } catch (e) {
      closeConn(doc, conn)
      clearInterval(pingInterval)
    }
  }, PING_MS)

  conn.on('close', () => {
    closeConn(doc, conn)
    clearInterval(pingInterval)
  })
  conn.on('pong', () => {
    pongReceived = true
  })

  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, doc)
  send(doc, conn, encoding.toUint8Array(encoder))
  const awarenessStates = doc.awareness.getStates()
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, messageAwareness)
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(
        doc.awareness,
        Array.from(awarenessStates.keys())
      )
    )
    send(doc, conn, encoding.toUint8Array(awarenessEncoder))
  }
}

module.exports = { setupWSConnection, docs }
