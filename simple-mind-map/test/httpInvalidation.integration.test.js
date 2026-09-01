const assert = require('assert')
const crypto = require('crypto')
const Y = require('yjs')
const WebSocket = require('ws')
const { WebsocketProvider } = require('y-websocket')

const wsUrl = process.env.COLLAB_DIRECT_WS_URL || 'ws://127.0.0.1:1234'
const roomKey = `presence-${crypto.randomUUID()}`

function connect(doc) {
  return new WebsocketProvider(wsUrl, roomKey, doc, {
    WebSocketPolyfill: WebSocket,
    connect: true,
    maxBackoffTime: 1000
  })
}

async function main() {
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const providerA = connect(docA)
  const providerB = connect(docB)
  const change = {
    roomKey: 'map-1',
    userId: 'user-a',
    clientId: providerA.awareness.clientID,
    updatedAt: new Date().toISOString(),
    nonce: crypto.randomUUID()
  }

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('presence invalidation timeout')),
        10000
      )
      providerB.awareness.on('change', () => {
        const received = Array.from(providerB.awareness.getStates().values())
          .map(state => state.documentChange)
          .find(item => item && item.nonce === change.nonce)
        if (!received) return
        clearTimeout(timer)
        assert.deepStrictEqual(received, change)
        resolve()
      })
      providerA.on('status', ({ status }) => {
        if (status !== 'connected') return
        providerA.awareness.setLocalStateField('documentChange', change)
      })
      providerA.on('connection-error', reject)
      providerB.on('connection-error', reject)
    })
    console.log('http invalidation integration passed')
  } finally {
    providerA.destroy()
    providerB.destroy()
    docA.destroy()
    docB.destroy()
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
