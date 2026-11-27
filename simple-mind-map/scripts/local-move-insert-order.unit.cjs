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
    `return ({\n${rest.slice(0, end)}\n}).${name}`)(applyCollabEvent, () => {},
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
    acknowledgeLocalNodeDeletion: method('acknowledgeLocalNodeDeletion'),
    acknowledgeLocalNodeCreation: method('acknowledgeLocalNodeCreation')
  }
  return { state, children, parent }
}

// 构造初始快照无 position 的同父节点夹具，覆盖本地删除后再新增的错位场景
function deleteThenInsertFixture() {
  const children = ['n0', 'erji', 'test1'].map(uid => ({ data: { uid }, children: [] }))
  const parent = { nodeData: { children }, getData: () => children.length, setData: () => {} }
  const tombstoned = new Set(['deleted1'])
  const state = {
    currentData: {
      p: { data: { uid: 'p' }, children: ['n0', 'erji', 'deleted1', 'test1'] },
      n0: { data: { uid: 'n0' }, children: [] },
      erji: { data: { uid: 'erji' }, children: [] },
      deleted1: { data: { uid: 'deleted1' }, children: [] },
      test1: { data: { uid: 'test1' }, children: [] }
    },
    mindMap: { renderer: { findNodeByUid: uid => uid === 'p' ? parent : null } },
    _v2RemoteApplyQueue: Promise.resolve(),
    isV2RevisionScopeCurrent: () => true,
    markV2RevisionComplete: async () => true,
    isPersistAcked: () => true,
    isTombstonedUid: uid => tombstoned.has(String(uid)),
    getEditSessionSnapshot: () => null,
    editSessionManager: { list: () => [] },
    requestRemoteApplyRender: () => {},
    projectCanonicalChildOrder: method('projectCanonicalChildOrder'),
    acknowledgeLocalNodePlacement: method('acknowledgeLocalNodePlacement'),
    acknowledgeLocalNodeDeletion: method('acknowledgeLocalNodeDeletion'),
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

  // 验证单删和批量删除 ACK 均会更新 currentData，后续新增 test2 不会跑到 test1 上方
  for (const batch of [false, true]) {
    const { state, children, parent } = deleteThenInsertFixture()
    const del = { uid: 'deleted1', parentUid: 'p', removed: ['deleted1'], keepChildren: false, promoted: [] }
    await ack(state, batch ? 'batch.applied' : 'node.deleted',
      batch ? { events: [{ type: 'node.deleted', payload: del }] } : del, 10)
    assert.deepEqual(state.currentData.p.children, ['n0', 'erji', 'test1'],
      '本地删除 ACK 必须同步清理 currentData 中的父级 children')
    assert.equal(state.currentData.deleted1, undefined)
    // 模拟在 test1 后新增 test2，服务端按 3 个存活节点返回 index = 3
    method('insertChildNodeData', renderSource).call({
      mindMap: { command: { isCountableNode: () => true } }
    }, parent, { data: { uid: 'test2' }, children: [] })
    await ack(state, 'node.insert', {
      uid: 'test2', parent: 'p', index: 3, position: 'I000000000000000', data: { uid: 'test2' }
    }, 11)
    assert.deepEqual(state.currentData.p.children, ['n0', 'erji', 'test1', 'test2'])
    assert.deepEqual(children.map(child => child.data.uid), ['n0', 'erji', 'test1', 'test2'],
      '删除同级节点后新增 test2 必须保持在 test1 下方')
    assert.equal(state._pendingChildOrderParents.has('p'), false,
      '清理幽灵节点后不应残留待投影父节点')
  }

  // 验证旧版本号删除 ACK 不会误删更高版本节点
  {
    const { state } = deleteThenInsertFixture()
    state._structuralGuardRevisions = new Map([['deleted1', 20]])
    await ack(state, 'node.deleted', { uid: 'deleted1', parentUid: 'p', removed: ['deleted1'] }, 10)
    assert.ok(state.currentData.deleted1, '旧版本删除 ACK 不得覆盖更新的结构版本')
  }

  // 验证即使 delete ACK 尚未同步到 currentData，已墓碑化的节点也不会拖偏新插入节点顺序
  {
    const { state, children, parent } = deleteThenInsertFixture()
    method('insertChildNodeData', renderSource).call({
      mindMap: { command: { isCountableNode: () => true } }
    }, parent, { data: { uid: 'test2' }, children: [] })
    await ack(state, 'node.insert', {
      uid: 'test2', parent: 'p', index: 3, position: 'I000000000000000', data: { uid: 'test2' }
    }, 11)
    assert.deepEqual(children.map(child => child.data.uid), ['n0', 'erji', 'test1', 'test2'],
      '墓碑过滤兜底必须防止新节点前移')
  }

  // 验证保留子节点删除（keepChildren: true）后新增顺序正确
  {
    const children = ['n0', 'childA', 'test1'].map(uid => ({ data: { uid }, children: [] }))
    const parent = { nodeData: { children }, getData: () => children.length, setData: () => {} }
    const state = {
      currentData: {
        p: { data: { uid: 'p' }, children: ['n0', 'mid', 'test1'] },
        n0: { data: { uid: 'n0' }, children: [] },
        mid: { data: { uid: 'mid' }, children: ['childA'] },
        childA: { data: { uid: 'childA' }, children: [] },
        test1: { data: { uid: 'test1' }, children: [] }
      },
      mindMap: { renderer: { findNodeByUid: uid => uid === 'p' ? parent : null } },
      _v2RemoteApplyQueue: Promise.resolve(),
      isV2RevisionScopeCurrent: () => true,
      markV2RevisionComplete: async () => true,
      isPersistAcked: () => true,
      isTombstonedUid: uid => String(uid) === 'mid',
      getEditSessionSnapshot: () => null,
      editSessionManager: { list: () => [] },
      requestRemoteApplyRender: () => {},
      projectCanonicalChildOrder: method('projectCanonicalChildOrder'),
      acknowledgeLocalNodePlacement: method('acknowledgeLocalNodePlacement'),
      acknowledgeLocalNodeDeletion: method('acknowledgeLocalNodeDeletion'),
      acknowledgeLocalNodeCreation: method('acknowledgeLocalNodeCreation')
    }
    await ack(state, 'node.deleted', {
      uid: 'mid', parentUid: 'p', removed: ['mid'], keepChildren: true, promoted: ['childA']
    }, 10)
    assert.deepEqual(state.currentData.p.children, ['n0', 'childA', 'test1'])
    method('insertChildNodeData', renderSource).call({
      mindMap: { command: { isCountableNode: () => true } }
    }, parent, { data: { uid: 'test2' }, children: [] })
    await ack(state, 'node.insert', {
      uid: 'test2', parent: 'p', index: 3, position: 'I000000000000000', data: { uid: 'test2' }
    }, 11)
    assert.deepEqual(children.map(child => child.data.uid), ['n0', 'childA', 'test1', 'test2'])
  }

  console.log('Local move ACK and child insertion order passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
