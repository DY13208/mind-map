const assert = require('assert')
const crypto = require('crypto')
const Y = require('yjs')
const WebSocket = require('ws')
const { WebsocketProvider } = require('y-websocket')
const { applyObjectToDoc } = require('../bin/collabYjs')

const baseUrl = process.env.COLLAB_TEST_BASE_URL || 'http://127.0.0.1:8080'
const wsUrl = baseUrl.replace(/^http/, 'ws') + '/collab'
const roomKey = `test-${crypto.randomUUID()}`

const node = (uid, text, children = []) => ({
  isRoot: uid === 'root',
  data: { uid, text, expand: true },
  children
})

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(check, label, timeout = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const result = await check()
    if (result) return result
    await delay(100)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, options)
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

function connect(doc) {
  const provider = new WebsocketProvider(wsUrl, roomKey, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.destroy()
      reject(new Error('websocket sync timeout'))
    }, 10000)
    provider.on('sync', synced => {
      if (!synced) return
      clearTimeout(timer)
      resolve(provider)
    })
    provider.on('connection-error', reject)
  })
}

async function expectPolicyClose(doc) {
  const provider = new WebsocketProvider(wsUrl, roomKey, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.destroy()
      reject(new Error('deleted room accepted a websocket connection'))
    }, 5000)
    provider.on('connection-close', event => {
      if (event && event.code === 1008) {
        clearTimeout(timer)
        provider.destroy()
        resolve()
      }
    })
  })
}

async function main() {
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const providerA = await connect(docA)
  const providerB = await connect(docB)

  const initial = { root: node('root', 'Root') }
  applyObjectToDoc(docA, initial, { replace: true })
  await waitFor(
    () => docB.getMap().toJSON().root,
    'initial document synchronization'
  )

  applyObjectToDoc(
    docA,
    { root: node('root', 'ARoot') },
    { previousObject: initial }
  )
  applyObjectToDoc(
    docB,
    { root: node('root', 'RootB') },
    { previousObject: initial }
  )
  await waitFor(() => {
    return (
      docA.getMap().toJSON().root.data.text === 'ARootB' &&
      docB.getMap().toJSON().root.data.text === 'ARootB'
    )
  }, 'concurrent Y.Text convergence')

  const beforeBranches = docA.getMap().toJSON()
  applyObjectToDoc(
    docA,
    {
      ...beforeBranches,
      root: node('root', 'ARootB', ['a']),
      a: node('a', 'A')
    },
    { previousObject: beforeBranches }
  )
  applyObjectToDoc(
    docB,
    {
      ...beforeBranches,
      root: node('root', 'ARootB', ['b']),
      b: node('b', 'B')
    },
    { previousObject: beforeBranches }
  )
  await waitFor(() => {
    const children = docA.getMap().toJSON().root.children || []
    return children.includes('a') && children.includes('b')
  }, 'concurrent branch convergence')

  await waitFor(async () => {
    const { response, data } = await request(
      `/api/files/${encodeURIComponent(roomKey)}/save-status`
    )
    return response.ok && data.status === 'saved' && data.updated_at
  }, 'persistent save')

  providerA.destroy()
  providerB.destroy()
  docA.destroy()
  docB.destroy()
  await delay(500)

  const docC = new Y.Doc()
  const providerC = await connect(docC)
  await waitFor(() => {
    const json = docC.getMap().toJSON()
    return json.root && json.a && json.b && json.root.data.text === 'ARootB'
  }, 'reload from persistence')

  const current = docC.getMap().toJSON()
  applyObjectToDoc(
    docC,
    { ...current, root: { ...current.root, data: { ...current.root.data, note: 'pending' } } },
    { previousObject: current }
  )

  const closed = new Promise(resolve => {
    providerC.on('connection-close', event => {
      if (event && event.code === 1008) resolve()
    })
  })
  const deleted = await request(`/api/files/${encodeURIComponent(roomKey)}`, {
    method: 'DELETE'
  })
  assert.strictEqual(deleted.response.status, 200)
  await closed
  providerC.destroy()
  docC.destroy()

  await delay(2500)
  const afterDelete = await request(`/api/files/${encodeURIComponent(roomKey)}`)
  assert.strictEqual(afterDelete.response.status, 404)
  const status = await request(
    `/api/files/${encodeURIComponent(roomKey)}/save-status`
  )
  assert.strictEqual(status.data.status, 'deleted')
  await expectPolicyClose(new Y.Doc())

  console.log(`collab websocket integration passed (${roomKey})`)
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})

