const assert = require('assert')
const Y = require('yjs')
const mindDoc = require('../bin/mindDoc')
const { applyNodeCommand } = require('../bin/roomCommands')
const {
  planCollabRecovery,
  planAfterOperations,
  applyCollabEvent,
  applyCollabEvents,
  markDirtySubtrees
} = require('../bin/collabRecovery')
const { evaluateUndo, evaluateRedo, reconstructByInverses } = require('../bin/collabUndo')

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
  assert.ok(applied.event.payload.position)
  assert.strictEqual(applied.event.payload.index, 0)
  assert.strictEqual(applied.result.position, applied.event.payload.position)
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

function testPreviewStampsMetaAndKnownVersion() {
  const obj = {
    root: node('root', 'Root', ['a']),
    a: node('a', 'A', ['b']),
    b: node('b', 'B')
  }
  const preview = mindDoc.buildPreview(obj, { keepDepth: 2, version: 7 })
  assert.strictEqual(preview.tree.data.childCount, 1)
  assert.strictEqual(preview.tree.data.subtreeVersion, 7)
  assert.strictEqual(preview.tree.children[0].data.childCount, 1)
  assert.strictEqual(preview.tree.children[0].data.subtreeVersion, 7)

  const skip = mindDoc.versionedSubtree(obj, 'root', {
    version: 4,
    knownVersion: 4
  })
  assert.strictEqual(skip.unchanged, true)
  assert.strictEqual(skip.version, 4)
  assert.ok(!skip.children)

  const fresh = mindDoc.versionedSubtree(obj, 'root', {
    version: 5,
    knownVersion: 4
  })
  assert.strictEqual(fresh.unchanged, false)
  assert.strictEqual(fresh.total, 1)
  assert.strictEqual(fresh.children[0].data.uid, 'a')
  assert.strictEqual(fresh.children[0].data.subtreeVersion, 5)
}

function testMarkDirtySubtreesForUnloadedBranch() {
  const dirty = markDirtySubtrees(['root', 'loaded'], [
    {
      version: 12,
      event: {
        type: 'node.inserted',
        affectedUids: ['hidden', 'loaded'],
        payload: { uid: 'hidden', parentUid: 'loaded' }
      }
    }
  ])
  assert.deepStrictEqual(dirty, { loaded: 12 })

  const clean = markDirtySubtrees(['root', 'a'], [
    {
      version: 3,
      event: {
        type: 'node.updated',
        affectedUids: ['a'],
        payload: { uid: 'a' }
      }
    }
  ])
  assert.deepStrictEqual(clean, {})
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
  ;[100, 1000, 10000, 100000].forEach(n => {
    const obj = make(n)
    const t0 = process.hrtime.bigint()
    const preview = mindDoc.buildPreview(obj, { keepDepth: 2, maxChildren: 8 })
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    timings[n] = Number(ms.toFixed(2))
    assert.ok(preview.node_count === n + 1)
    if (n >= 10000) {
      assert.strictEqual(preview.clipped, true)
      assert.ok(preview.tree.children.length <= 8)
      assert.ok(preview.tree.data.childCount === n)
    }
    const limit = n >= 100000 ? 15000 : n >= 10000 ? 3000 : 800
    assert.ok(ms < limit, `${n} preview took ${ms}ms`)
  })
  console.log('preview timings ms', JSON.stringify(timings))
}

function testUndoSafetyBlocksOtherUsersAndOutOfOrder() {
  const insert = {
    operation_id: 'op-insert',
    actor_id: 'alice',
    operation_type: 'node.insert',
    version: 1,
    inverse_payload: { type: 'node.delete', payload: { uid: 'n1' } },
    event: {
      type: 'node.inserted',
      affectedUids: ['n1', 'root'],
      payload: { uid: 'n1' }
    }
  }
  const otherEdit = {
    operation_id: 'op-bob',
    actor_id: 'bob',
    operation_type: 'node.update',
    version: 2,
    event: {
      type: 'node.updated',
      affectedUids: ['n1'],
      payload: { uid: 'n1' }
    }
  }
  const conflict = evaluateUndo(insert, [otherEdit], 'alice')
  assert.strictEqual(conflict.ok, false)
  assert.strictEqual(conflict.code, 'UNDO_CONFLICT')

  const ownLater = {
    operation_id: 'op-alice-2',
    actor_id: 'alice',
    operation_type: 'node.update',
    version: 2,
    event: {
      type: 'node.updated',
      affectedUids: ['n1'],
      payload: { uid: 'n1' }
    }
  }
  const stale = evaluateUndo(insert, [ownLater], 'alice')
  assert.strictEqual(stale.ok, false)
  assert.strictEqual(stale.code, 'UNDO_OUT_OF_ORDER')

  const unrelated = {
    operation_id: 'op-bob-2',
    actor_id: 'bob',
    operation_type: 'node.insert',
    version: 2,
    event: {
      type: 'node.inserted',
      affectedUids: ['n2', 'root'],
      payload: { uid: 'n2' }
    }
  }
  const allowed = evaluateUndo(insert, [unrelated], 'alice')
  assert.strictEqual(allowed.ok, true)
  assert.strictEqual(allowed.inverse.type, 'node.delete')

  const siblingInsert = {
    operation_id: 'op-alice-n2',
    actor_id: 'alice',
    operation_type: 'node.insert',
    version: 2,
    event: {
      type: 'node.inserted',
      affectedUids: ['n2', 'root'],
      payload: { uid: 'n2', parentUid: 'root' }
    }
  }
  const siblingOk = evaluateUndo(insert, [siblingInsert], 'alice')
  assert.strictEqual(siblingOk.ok, true)

  const already = evaluateUndo(insert, [
    {
      operation_id: 'op-undo',
      actor_id: 'alice',
      operation_type: 'operation.undo',
      version: 3,
      event: {
        type: 'operation.undone',
        payload: { targetOperationId: 'op-insert' }
      }
    }
  ], 'alice')
  assert.strictEqual(already.code, 'ALREADY_UNDONE')

  const forbidden = evaluateUndo(insert, [], 'bob')
  assert.strictEqual(forbidden.code, 'UNDO_FORBIDDEN')
}

function testRestoreAndHistoricalReplay() {
  const initial = {
    root: node('root', 'Root', ['a']),
    a: node('a', 'A')
  }
  const doc = seedDoc(initial)
  const deleted = applyNodeCommand(doc, {
    type: 'node.delete',
    payload: { uid: 'a', confirm_sop_change: true }
  })
  assert.ok(!mindDoc.readObject(doc).a)
  applyNodeCommand(doc, {
    type: 'node.restore',
    payload: {
      ...deleted.inversePayload.payload,
      confirm_sop_change: true
    }
  })
  assert.strictEqual(mindDoc.readObject(doc).a.data.text, 'A')
  assert.deepStrictEqual(mindDoc.readObject(doc).root.children, ['a'])

  const afterInsert = {
    root: node('root', 'Root', ['a', 'b']),
    a: node('a', 'A'),
    b: node('b', 'B')
  }
  const replayed = reconstructByInverses(afterInsert, [
    {
      version: 1,
      inverse_payload: { type: 'node.delete', payload: { uid: 'b' } }
    }
  ])
  assert.ok(!replayed.b)
  assert.deepStrictEqual(replayed.root.children, ['a'])
}

function testConcurrentSiblingInsertsGetDistinctPositions() {
  const doc = seedDoc({ root: node('root', 'Root') })
  applyNodeCommand(doc, {
    type: 'node.insert',
    payload: { parentUid: 'root', uid: 'first', text: 'First', index: 0 }
  })
  applyNodeCommand(doc, {
    type: 'node.insert',
    payload: { parentUid: 'root', uid: 'second', text: 'Second', index: 0 }
  })
  const obj = mindDoc.readObject(doc)
  assert.deepStrictEqual(obj.root.children, ['second', 'first'])
  assert.ok(obj.second.position)
  assert.ok(obj.first.position)
  assert.notStrictEqual(obj.second.position, obj.first.position)
  assert.ok(obj.second.position < obj.first.position)

  const replayed = applyCollabEvents(
    { root: node('root', 'Root') },
    [
      {
        event: {
          type: 'node.inserted',
          payload: {
            uid: 'first',
            parentUid: 'root',
            text: 'First',
            position: obj.first.position,
            index: 1
          }
        }
      },
      {
        event: {
          type: 'node.inserted',
          payload: {
            uid: 'second',
            parentUid: 'root',
            text: 'Second',
            position: obj.second.position,
            index: 0
          }
        }
      }
    ]
  )
  assert.deepStrictEqual(replayed.nodes.root.children, ['second', 'first'])
}

function testRedoRequiresUndoAndBlocksDoubleRedo() {
  const insert = {
    operation_id: 'op-insert',
    actor_id: 'alice',
    operation_type: 'node.insert',
    version: 1,
    payload: { uid: 'n1', parentUid: 'root', text: 'One' },
    inverse_payload: { type: 'node.delete', payload: { uid: 'n1' } },
    event: {
      type: 'node.inserted',
      affectedUids: ['n1', 'root'],
      payload: { uid: 'n1' }
    }
  }
  const unavailable = evaluateRedo(insert, [], 'alice')
  assert.strictEqual(unavailable.ok, false)
  assert.strictEqual(unavailable.code, 'REDO_UNAVAILABLE')

  const undoOp = {
    operation_id: 'op-undo',
    actor_id: 'alice',
    operation_type: 'operation.undo',
    version: 2,
    payload: { targetOperationId: 'op-insert' },
    event: {
      type: 'operation.undone',
      payload: {
        targetOperationId: 'op-insert',
        inverse: insert.inverse_payload
      }
    }
  }
  const allowed = evaluateRedo(insert, [undoOp], 'alice')
  assert.strictEqual(allowed.ok, true)
  assert.strictEqual(allowed.forward.type, 'node.insert')

  const redoOp = {
    operation_id: 'op-redo',
    actor_id: 'alice',
    operation_type: 'operation.redo',
    version: 3,
    payload: { targetOperationId: 'op-insert' },
    event: {
      type: 'operation.redone',
      payload: { targetOperationId: 'op-insert' }
    }
  }
  const again = evaluateRedo(insert, [undoOp, redoOp], 'alice')
  assert.strictEqual(again.ok, false)
  assert.strictEqual(again.code, 'ALREADY_REDONE')
}

testInsertUpdateMoveDeleteStayOnTempDoc()
testInsertRecordsInverseAndResolvedUid()
testSopChangesRequireConfirmation()
testRecoveryPlannerDetectsGapsAndResnapshot()
testApplyCollabEventsReplayInsertUpdateMoveDelete()
testApplyCollabEventKeepChildrenAndTitleNoop()
testPreviewStampsMetaAndKnownVersion()
testMarkDirtySubtreesForUnloadedBranch()
testUndoSafetyBlocksOtherUsersAndOutOfOrder()
testRedoRequiresUndoAndBlocksDoubleRedo()
testRestoreAndHistoricalReplay()
testConcurrentSiblingInsertsGetDistinctPositions()
testPreviewTimings()
console.log('room operation tests passed')
