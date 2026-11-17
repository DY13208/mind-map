const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../src/plugins/Cooperate.js'), 'utf8')
const renderSource = fs.readFileSync(path.join(__dirname, '../src/core/render/Render.js'), 'utf8')
const recovery = fs.readFileSync(path.join(__dirname, '../src/plugins/cooperateRecovery.js'), 'utf8')
const { applyCollabEvent } = new Function(
  recovery.replace(/export /g, '') + '\nreturn { applyCollabEvent }'
)()

function method(name, fileSource = source) {
  const start = fileSource.indexOf(`\n  ${name}(`)
  if (start < 0) return undefined
  const rest = fileSource.slice(start + 1)
  const end = rest.search(/\n  (?:async )?\w+\(/)
  return new Function('applyCollabEvent', 'v2Trace', 'readFieldVersions', 'payloadParentUid',
    `return ({${rest.slice(0, end)}}).${name}`)(applyCollabEvent, () => {},
    data => data && data._fieldVersions || {},
    payload => payload.parentUid || payload.parent_uid || payload.parent)
}

function fixture() {
  const children = ['jd', 'tmall', 'live'].map(uid => ({ data: { uid }, children: [] }))
  const parent = { nodeData: { children }, getData: () => children.length, setData: () => {} }
  const state = {
    currentData: {
      p: { data: { uid: 'p' }, children: ['tmall', 'live', 'jd'] },
      tmall: { data: { uid: 'tmall' }, children: [], position: 'B' },
      live: { data: { uid: 'live' }, children: [], position: 'C' },
      jd: { data: { uid: 'jd' }, children: [], position: 'D' }
    },
    mindMap: { renderer: { findNodeByUid: uid => uid === 'p' ? parent : null } },
    _v2RemoteApplyQueue: Promise.resolve(),
    isV2RevisionScopeCurrent: () => true,
    markV2RevisionComplete: async () => true,
    isPersistAcked: () => true,
    isTombstonedUid: () => false,
    getEditSessionSnapshot: () => null,
    editSessionManager: { list: () => [] },
    requestRemoteApplyRender: () => {},
    projectCanonicalChildOrder: method('projectCanonicalChildOrder'),
    acknowledgeLocalNodePlacement: method('acknowledgeLocalNodePlacement'),
    acknowledgeLocalNodeCreation: method('acknowledgeLocalNodeCreation')
  }
  return { state, children, parent }
}

async function ack(state, type, payload, revision) {
  await method('reconcileAckedLocalOperation').call(state, {
    operation: { type, payload, serverRevision: revision }
  }, new Map(), null, type, payload)
}

async function run() {
  for (const batch of [false, true]) {
    const { state, children, parent } = fixture()
    const move = { uid: 'jd', parentUid: 'p', index: 0, position: 'A' }
    await ack(state, batch ? 'batch.applied' : 'node.moved',
      batch ? { events: [{ type: 'node.moved', payload: move }] } : move, 1)
    assert.deepEqual(state.currentData.p.children, ['jd', 'tmall', 'live'],
      'a local move ACK must update canonical sibling order')
    for (const [index, uid] of ['new1', 'new2'].entries()) {
      method('insertChildNodeData', renderSource).call({
        mindMap: { command: { isCountableNode: () => true } }
      }, parent, { data: { uid }, children: [] })
      await ack(state, 'node.insert', {
        uid, parent: 'p', index: index + 3, position: index ? 'F' : 'E', data: { uid }
      }, index + 2)
      assert.deepEqual(children.map(child => child.data.uid),
        ['jd', 'tmall', 'live', ...['new1', 'new2'].slice(0, index + 1)])
    }
    await ack(state, 'node.reordered', {
      uid: 'jd', parent: 'p', index: 3, position: 'G'
    }, 5)
    await ack(state, 'node.moved', move, 1)
    assert.equal(state.currentData.jd.position, 'G', 'an old ACK must preserve newer placement')
  }
  console.log('Local move ACK and child insertion order passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
