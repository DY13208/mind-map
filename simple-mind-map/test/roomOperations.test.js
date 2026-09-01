const assert = require('assert')
const Y = require('yjs')
const mindDoc = require('../bin/mindDoc')
const { applyNodeCommand } = require('../bin/roomCommands')
const {
  planCollabRecovery,
  planAfterOperations,
  applyCollabEvent,
  applyCollabEvents
} = require('../bin/collabRecovery')

const node = (uid, text, children = [], extra = {}) => ({
  isRoot: uid === 'root',
  data: { uid, text, ...extra },
  children
})

function seedDoc(obj) {
  const doc = new Y.Doc()
  mindDoc.applyObjectToDoc(doc, obj, { replace: true })
  return doc
}

function testInsertUpdateMoveDeleteStayOnTempDoc() {
  const initial = {
    root: node('root', 'Root', ['a']),
    a: node('a', 'A')
  }
  const live = seedDoc(initial)
  const temp = seedDoc(mindDoc.readObject(live))
  const inserted = applyNodeCommand(temp, {
    type: 'node.insert',
    payload: { parentUid: 'root', uid: 'b', text: 'B' }
  })
  assert.strictEqual(inserted.result.uid, 'b')
  assert.deepStrictEqual(mindDoc.readObject(live).root.children, ['a'])
  assert.deepStrictEqual(mindDoc.readObject(temp).root.children, ['a', 'b'])

  applyNodeCommand(temp, {
    type: 'node.update',
    payload: { uid: 'b', patch: { note: 'keep' } }
  })
  applyNodeCommand(temp, {
    type: 'node.move',
    payload: { uid: 'b', parentUid: 'a', index: 0 }
  })
  assert.strictEqual(mindDoc.readObject(temp).a.children[0], 'b')
  assert(!mindDoc.readObject(live).b)

  const deleted = applyNodeCommand(temp, {
    type: 'node.delete',
    payload: { uid: 'a' }
  })
  assert.deepStrictEqual(deleted.result.removed.sort(), ['a', 'b'])
  assert(mindDoc.readObject(live).a)
  assert.deepStrictEqual(Object.keys(mindDoc.readObject(temp)).sort(), ['root'])
}

function testInsertRecordsInverseAndResolvedUid() {
  const doc = seedDoc({ root: node('root', 'Root') })
  const payload = { parentUid: 'root', text: 'Child' }
  const applied = applyNodeCommand(doc, {
    type: 'node.insert',
    payload
  })
  assert.ok(applied.result.uid)
  assert.strictEqual(payload.uid, applied.result.uid)
  assert.strictEqual(applied.inversePayload.type, 'node.delete')
  assert.strictEqual(applied.event.type, 'node.inserted')
  assert.deepStrictEqual(applied.event.affectedUids, [
    applied.result.uid,
    'root'
  ])
}

function testSopChangesRequireConfirmation() {
  const obj = {
    root: node('root', 'Root', ['sop']),
    sop: node('sop', 'SOP', ['goal']),
    goal: node('goal', '目标：测试')
  }
  const doc = seedDoc(obj)
  assert.throws(
    () =>
      applyNodeCommand(doc, {
        type: 'node.insert',
        payload: { parentUid: 'goal', text: '未确认' }
      }),
    /confirm_sop_change/
  )
  const applied = applyNodeCommand(doc, {
    type: 'node.insert',
    payload: {
      parentUid: 'goal',
      uid: 'step',
      text: '已确认',
      confirm_sop_change: true
    }
  })
  assert.strictEqual(applied.result.uid, 'step')
}

function testRecoveryPlannerDetectsGapsAndResnapshot() {
  assert.strictEqual(planCollabRecovery(10, 10).type, 'ignore')
  assert.strictEqual(planCollabRecovery(10, 9).type, 'ignore')
  assert.deepStrictEqual(planCollabRecovery(10, 11), {
    type: 'fetch_operations',
    afterVersion: 10,
    version: 11
  })
  assert.deepStrictEqual(planCollabRecovery(10, 520), {
    type: 'resnapshot',
    version: 520
  })
  assert.deepStrictEqual(
    planAfterOperations(10, {
      currentVersion: 12,
      operations: [{ version: 11 }, { version: 12 }],
      hasMore: false
    }),
    {
      type: 'apply',
      operations: [{ version: 11 }, { version: 12 }],
      version: 12
    }
  )
  assert.deepStrictEqual(
    planAfterOperations(10, {
      currentVersion: 20,
      operations: [],
      hasMore: false
    }),
    { type: 'resnapshot', version: 20 }
  )
  assert.deepStrictEqual(
    planAfterOperations(10, {
      currentVersion: 11,
      operations: [
        {
          version: 11,
          event: {
            type: 'map.replaced',
            payload: { resnapshot: true }
          }
        }
      ],
      hasMore: false
    }),
    { type: 'resnapshot', version: 11 }
  )
}

function testApplyCollabEventsReplayInsertUpdateMoveDelete() {
  const initial = {
    root: node('root', 'Root', ['a']),
    a: node('a', 'A')
  }
  const doc = seedDoc(initial)
  const events = []
  events.push(
    applyNodeCommand(doc, {
      type: 'node.insert',
      payload: { parentUid: 'root', uid: 'b', text: 'B' }
    }).event
  )
  events.push(
    applyNodeCommand(doc, {
      type: 'node.update',
      payload: { uid: 'b', patch: { note: 'keep' } }
    }).event
  )
  events.push(
    applyNodeCommand(doc, {
      type: 'node.move',
      payload: { uid: 'b', parentUid: 'a', index: 0 }
    }).event
  )
  events.push(
    applyNodeCommand(doc, {
      type: 'node.delete',
      payload: { uid: 'a' }
    }).event
  )
  const replayed = applyCollabEvents(initial, events.map(event => ({ event })))
  assert.strictEqual(replayed.type, 'apply')
  assert.deepStrictEqual(mindDoc.readObject(doc), replayed.nodes)
  assert.deepStrictEqual(Object.keys(replayed.nodes).sort(), ['root'])
}

function testApplyCollabEventKeepChildrenAndTitleNoop() {
  const initial = {
    root: node('root', 'Root', ['a']),
    a: node('a', 'A', ['b']),
    b: node('b', 'B')
  }
  const deleted = applyCollabEvent(initial, {
    type: 'node.deleted',
    payload: { uid: 'a', keepChildren: true, promoted: ['b'] }
  })
  assert.deepStrictEqual(deleted.root.children, ['b'])
  assert(!deleted.a)
  assert.strictEqual(deleted.b.data.text, 'B')
  const titled = applyCollabEvent(deleted, {
    type: 'map.updated',
    payload: { title: '新标题', resnapshot: false }
  })
  assert.deepStrictEqual(titled, deleted)
  const batch = applyCollabEvents(initial, [
    {
      event: {
        type: 'map.replaced',
        payload: { resnapshot: true }
      }
    }
  ])
  assert.strictEqual(batch.type, 'resnapshot')
  assert.strictEqual(batch.index, 0)
}

function testPreviewTimings() {
  const make = n => {
    const obj = { root: node('root', 'Root', []) }
    for (let i = 0; i < n; i++) {
      const uid = 'n' + i
      obj.root.children.push(uid)
      obj[uid] = node(uid, 'N' + i)
    }
    return obj
  }
  const timings = {}
  ;[100, 1000, 10000].forEach(n => {
    const obj = make(n)
    const t0 = process.hrtime.bigint()
    const preview = mindDoc.buildPreview(obj, { keepDepth: 2, maxChildren: 8 })
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    timings[n] = Number(ms.toFixed(2))
    assert.ok(preview.node_count === n + 1)
    assert.ok(ms < (n >= 10000 ? 3000 : 800), `${n} preview took ${ms}ms`)
  })
  console.log('preview timings ms', JSON.stringify(timings))
}

testInsertUpdateMoveDeleteStayOnTempDoc()
testInsertRecordsInverseAndResolvedUid()
testSopChangesRequireConfirmation()
testRecoveryPlannerDetectsGapsAndResnapshot()
testApplyCollabEventsReplayInsertUpdateMoveDelete()
testApplyCollabEventKeepChildrenAndTitleNoop()
testPreviewTimings()
console.log('room operation tests passed')
