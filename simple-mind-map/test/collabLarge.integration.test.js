const assert = require('assert')
const crypto = require('crypto')
const Y = require('yjs')
const WebSocket = require('ws')
const { WebsocketProvider } = require('y-websocket')
const { applyObjectToDoc } = require('../bin/collabYjs')

const baseUrl = process.env.COLLAB_TEST_BASE_URL || 'http://127.0.0.1:8080'
const wsUrl = baseUrl.replace(/^http/, 'ws') + '/collab'
const roomKey = `large-test-${crypto.randomUUID()}`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(check, label, timeout = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`timeout waiting for ${label}`)
}

function connect(doc) {
  const provider = new WebsocketProvider(wsUrl, roomKey, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    connect: false
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket sync timeout')), 15000)
    provider.on('sync', synced => {
      if (!synced) return
      clearTimeout(timer)
      resolve(provider)
    })
    provider.on('connection-error', reject)
    provider.connect()
  })
}

async function main() {
  const doc = new Y.Doc()
  const provider = await connect(doc)
  const children = []
  let current = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'Large map' },
      children
    }
  }
  for (let i = 0; i < 5000; i++) {
    const uid = `node-${i}`
    children.push(uid)
    current[uid] = {
      isRoot: false,
      data: { uid, text: `Node ${i}` },
      children: []
    }
  }
  applyObjectToDoc(doc, current, { replace: true })
  await delay(500)

  let editBytes = 0
  doc.on('update', update => {
    editBytes += update.length
  })
  for (let i = 0; i < 200; i++) {
    const previous = current
    current = {
      ...current,
      'node-2500': {
        ...current['node-2500'],
        data: { ...current['node-2500'].data, text: `Changed ${i}` }
      }
    }
    applyObjectToDoc(doc, current, { previousObject: previous })
  }
  assert(editBytes < 200 * 1024, `200 edits emitted ${editBytes} bytes`)

  await waitFor(async () => {
    const response = await fetch(
      `${baseUrl}/api/files/${encodeURIComponent(roomKey)}/save-status`
    )
    const data = await response.json()
    return response.ok && data.status === 'saved'
  }, 'large room save')

  provider.destroy()
  doc.destroy()
  const deleted = await fetch(`${baseUrl}/api/files/${encodeURIComponent(roomKey)}`, {
    method: 'DELETE'
  })
  assert.strictEqual(deleted.status, 200)
  console.log(`large collab integration passed (${editBytes} edit bytes)`)
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
