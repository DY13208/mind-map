'use strict'

const assert = require('node:assert/strict')
const { replayOperations } = require('../bin/collabHistory/replayer')
const { fromCommitted } = require('../bin/collabV2/protocol')

const baseTree = {
  root: {
    isRoot: true,
    data: { uid: 'root', text: 'Root' },
    children: ['parent']
  },
  parent: {
    data: { uid: 'parent', text: 'Parent' },
    children: []
  }
}

async function main() {
  const generatedUid = 'server-generated-single-insert'
  const singleInsert = await replayOperations(baseTree, {}, [
    {
      room_key: 'history-unit',
      version: 2,
      operation_id: '00000000-0000-4000-8000-000000000002',
      operation_type: 'node.insert',
      payload: { parentUid: 'parent', data: { text: 'before update' } },
      event: {
        type: 'node.inserted',
        payload: {
          uid: generatedUid,
          parentUid: 'parent',
          data: { uid: generatedUid, text: 'before update' }
        }
      }
    },
    {
      room_key: 'history-unit',
      version: 3,
      operation_id: '00000000-0000-4000-8000-000000000003',
      operation_type: 'node.update',
      payload: { uid: generatedUid, patch: { text: 'after update' } },
      event: {
        type: 'node.updated',
        payload: { uid: generatedUid, patch: { text: 'after update' } }
      }
    }
  ], { requireContinuous: true, fromRevision: 1 })
  assert.equal(singleInsert.tree[generatedUid].data.text, 'after update')
  assert.deepEqual(singleInsert.tree.parent.children, [generatedUid])

  const nestedDataUid = 'server-provided-data-uid'
  const nestedUidInsert = await replayOperations(baseTree, {}, [
    {
      room_key: 'history-unit',
      version: 2,
      operation_id: '00000000-0000-4000-8000-000000000005',
      operation_type: 'node.insert',
      payload: { parentUid: 'parent', data: { uid: nestedDataUid, text: 'nested UID' } }
    }
  ])
  assert.equal(nestedUidInsert.tree[nestedDataUid].data.uid, nestedDataUid)

  await assert.rejects(
    replayOperations(baseTree, {}, [
      {
        room_key: 'history-unit',
        version: 2,
        operation_id: '00000000-0000-4000-8000-000000000006',
        operation_type: 'node.insert',
        payload: { parentUid: 'parent', data: { text: 'missing canonical UID' } }
      }
    ]),
    error => error.code === 'HISTORY_REPLAY_FAILED' &&
      /missing its canonical UID/.test(error.message) &&
      error.details.revision === 2
  )

  await assert.rejects(
    replayOperations(baseTree, {}, [
      {
        room_key: 'history-unit',
        version: 2,
        operation_id: '00000000-0000-4000-8000-000000000011',
        operation_type: 'node.batch',
        payload: {
          ops: [
            { type: 'node.insert', payload: { parentUid: 'parent', data: { text: 'legacy insert missing UID' } } }
          ]
        }
      }
    ]),
    error => error.code === 'HISTORY_REPLAY_FAILED' &&
      /missing its canonical UID/.test(error.message)
  )

  const batchGeneratedUid = 'server-generated-batch-insert'
  const partialBatch = await replayOperations(baseTree, {}, [
    {
      room_key: 'history-unit',
      version: 2,
      operation_id: '00000000-0000-4000-8000-000000000004',
      operation_type: 'node.batch',
      payload: {
        ops: [
          {
            type: 'node.insert',
            payload: { parentUid: 'parent', data: { text: 'committed batch insert' } }
          },
          {
            type: 'node.update',
            payload: { uid: 'missing-node', patch: { text: 'failed item' } }
          },
          {
            type: 'node.update',
            payload: { uid: batchGeneratedUid, patch: { text: 'must stay skipped' } },
            depends_on: [1]
          }
        ],
        __mcpResult: {
          outcome: 'partial',
          count: 1,
          failed: 2,
          items: [
            { index: 0, status: 'applied', type: 'node.insert', result: { uid: batchGeneratedUid } },
            { index: 1, status: 'failed', type: 'node.update', code: 'NODE_DELETED' },
            { index: 2, status: 'dependency_failed', type: 'node.update', code: 'MCP_BATCH_DEPENDENCY_FAILED', depends_on: [1] }
          ]
        }
      },
      event: {
        type: 'batch.applied',
        payload: { count: 1, events: [] }
      }
    }
  ], { requireContinuous: true, fromRevision: 1 })
  assert.equal(partialBatch.tree[batchGeneratedUid].data.text, 'committed batch insert')
  assert.deepEqual(partialBatch.tree.parent.children, [batchGeneratedUid])
  assert.equal(partialBatch.tree['missing-node'], undefined)

  const publicBatch = fromCommitted({
    room_key: 'history-unit',
    version: 2,
    operation_id: '00000000-0000-4000-8000-000000000007',
    operation_type: 'node.batch',
    payload: {
      ops: [
        { type: 'node.insert', payload: { parentUid: 'parent', data: { text: 'public insert' } } },
        { type: 'node.update', payload: { uid: 'missing-node', patch: { text: 'failed item' } } },
        { type: 'node.update', payload: { uid: 'parent', expected: { text: 'stale value' }, patch: { text: 'failed item must not replay' } } }
      ]
    },
    event: {
      type: 'batch.applied',
      payload: {
        count: 2,
        events: [
          {
            type: 'node.inserted',
            payload: {
              uid: 'public-event-insert-uid',
              parentUid: 'parent',
              index: 1,
              data: { uid: 'public-event-insert-uid', text: 'public insert' }
            }
          },
          {
            type: 'node.updated',
            payload: {
              uid: 'public-event-insert-uid',
              patch: { text: 'public event update' },
              data: { uid: 'public-event-insert-uid', text: 'public event update' }
            }
          }
        ]
      }
    }
  }, { roomKey: 'history-unit' })
  assert.equal(publicBatch.type, 'batch.applied')
  const sanitizedReplay = await replayOperations(baseTree, {}, [publicBatch])
  assert.equal(sanitizedReplay.tree['public-event-insert-uid'].data.text, 'public event update')
  assert.deepEqual(sanitizedReplay.tree.parent.children, ['public-event-insert-uid'])

  const sopTree = {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: ['sop'] },
    sop: { data: { uid: 'sop', text: 'SOP' }, children: [] }
  }
  const confirmedSopBatch = fromCommitted({
    room_key: 'history-unit',
    version: 2,
    operation_id: '00000000-0000-4000-8000-000000000012',
    operation_type: 'node.batch',
    payload: {
      ops: [
        { type: 'node.update', payload: { uid: 'sop', patch: { text: 'Renamed SOP' }, confirm_sop_change: true } }
      ]
    },
    event: {
      type: 'batch.applied',
      payload: {
        count: 1,
        events: [
          { type: 'node.updated', payload: { uid: 'sop', patch: { text: 'Renamed SOP' }, data: { uid: 'sop', text: 'Renamed SOP' } } }
        ]
      }
    }
  }, { roomKey: 'history-unit' })
  assert.equal(confirmedSopBatch.payload.ops[0].payload.confirm_sop_change, true)
  assert.equal(confirmedSopBatch.event.payload.events[0].payload.confirm_sop_change, undefined)
  const replayedConfirmedSop = await replayOperations(sopTree, {}, [confirmedSopBatch])
  assert.equal(replayedConfirmedSop.tree.sop.data.text, 'Renamed SOP')

  const moveFieldVersionBase = {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: ['left-parent', 'right-parent'] },
    'left-parent': { data: { uid: 'left-parent', text: 'Left' }, children: ['moving-node'] },
    'right-parent': { data: { uid: 'right-parent', text: 'Right' }, children: ['sibling-node'] },
    'moving-node': {
      data: {
        uid: 'moving-node', text: 'Keep text', note: 'Keep note', hyperlink: 'https://example.test/move',
        __fv: { text: 3, note: 3, hyperlink: 3 }
      },
      children: []
    },
    'sibling-node': { data: { uid: 'sibling-node', text: 'Sibling' }, children: [] }
  }
  const movedWithoutPatch = await replayOperations(moveFieldVersionBase, {}, [
    {
      room_key: 'history-unit', version: 2, operation_id: '00000000-0000-4000-8000-000000000015',
      operation_type: 'node.move', payload: { uid: 'moving-node', parentUid: 'right-parent', index: 0 },
      event: {
        type: 'node.moved',
        payload: {
          uid: 'moving-node', parentUid: 'right-parent', index: 0,
          text: 'Keep text', note: 'Keep note', data: { ...moveFieldVersionBase['moving-node'].data }
        }
      }
    },
    {
      room_key: 'history-unit', version: 3, operation_id: '00000000-0000-4000-8000-000000000016',
      operation_type: 'node.reorder', payload: { uid: 'moving-node', parentUid: 'right-parent', index: 1 },
      event: {
        type: 'node.reordered',
        payload: {
          uid: 'moving-node', parentUid: 'right-parent', index: 1,
          text: 'Keep text', note: 'Keep note', data: { ...moveFieldVersionBase['moving-node'].data }
        }
      }
    },
    {
      room_key: 'history-unit', version: 4, operation_id: '00000000-0000-4000-8000-000000000017',
      operation_type: 'node.update', payload: { uid: 'moving-node' },
      event: {
        type: 'node.updated',
        payload: {
          uid: 'moving-node', text: 'Keep text', note: 'Keep note',
          data: { ...moveFieldVersionBase['moving-node'].data }
        }
      }
    }
  ])
  assert.deepEqual(movedWithoutPatch.tree['moving-node'].data, moveFieldVersionBase['moving-node'].data)
  assert.deepEqual(movedWithoutPatch.tree['left-parent'].children, [])
  assert.deepEqual(movedWithoutPatch.tree['right-parent'].children, ['sibling-node', 'moving-node'])

  const afterBatchText = 'Updated inside batch'
  const afterBatchData = {
    ...moveFieldVersionBase['moving-node'].data,
    text: afterBatchText,
    __fv: { text: 5, note: 3, hyperlink: 3 }
  }
  const batchThenMove = await replayOperations(moveFieldVersionBase, {}, [
    {
      room_key: 'history-unit', version: 5,
      operation_id: '00000000-0000-4000-8000-000000000019',
      operation_type: 'node.batch',
      payload: { ops: [] },
      event: {
        type: 'batch.applied',
        payload: {
          count: 4,
          events: [
            {
              type: 'node.updated',
              payload: { uid: 'moving-node', data: afterBatchData }
            },
            {
              type: 'node.moved',
              payload: {
                uid: 'moving-node', parentUid: 'right-parent', index: 0,
                text: afterBatchText, note: 'Keep note', data: afterBatchData
              }
            },
            {
              type: 'node.reordered',
              payload: {
                uid: 'moving-node', parentUid: 'right-parent', index: 1,
                text: afterBatchText, note: 'Keep note', data: afterBatchData
              }
            },
            {
              type: 'node.updated',
              payload: {
                uid: 'moving-node', text: afterBatchText, note: 'Keep note', data: afterBatchData
              }
            }
          ]
        }
      }
    },
    {
      room_key: 'history-unit', version: 6,
      operation_id: '00000000-0000-4000-8000-000000000020',
      operation_type: 'node.move', payload: { uid: 'moving-node', parentUid: 'left-parent', index: 0 },
      event: {
        type: 'node.moved',
        payload: {
          uid: 'moving-node', parentUid: 'left-parent', index: 0,
          text: afterBatchText, note: 'Keep note', data: afterBatchData
        }
      }
    }
  ])
  assert.deepEqual(batchThenMove.tree['moving-node'].data, afterBatchData)
  assert.deepEqual(batchThenMove.tree['left-parent'].children, ['moving-node'])
  assert.deepEqual(batchThenMove.tree['right-parent'].children, ['sibling-node'])

  const legacyDataOnlyUpdate = await replayOperations(moveFieldVersionBase, {}, [
    {
      room_key: 'history-unit', version: 5, operation_id: '00000000-0000-4000-8000-000000000018',
      operation_type: 'node.update', payload: { uid: 'moving-node' },
      event: {
        type: 'node.updated',
        payload: {
          uid: 'moving-node',
          data: { ...moveFieldVersionBase['moving-node'].data, text: 'Legacy data-only edit' }
        }
      }
    }
  ])
  assert.equal(legacyDataOnlyUpdate.tree['moving-node'].data.text, 'Legacy data-only edit')
  assert.equal(legacyDataOnlyUpdate.tree['moving-node'].data.__fv.text, 5)

  const orderedBaseTree = {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: ['parent'] },
    parent: { data: { uid: 'parent', text: 'Parent' }, children: ['left', 'right'] },
    left: { data: { uid: 'left', text: 'Left' }, children: [] },
    right: { data: { uid: 'right', text: 'Right' }, children: [] }
  }
  const orderedInsertBatch = fromCommitted({
    room_key: 'history-unit',
    version: 2,
    operation_id: '00000000-0000-4000-8000-000000000013',
    operation_type: 'node.batch',
    payload: { ops: [] },
    event: {
      type: 'batch.applied',
      payload: {
        count: 2,
        events: [
          { type: 'node.inserted', payload: { uid: 'first-at-slot', parentUid: 'parent', index: 1, data: { uid: 'first-at-slot', text: 'First' } } },
          { type: 'node.inserted', payload: { uid: 'second-at-slot', parentUid: 'parent', index: 1, data: { uid: 'second-at-slot', text: 'Second' } } }
        ]
      }
    }
  }, { roomKey: 'history-unit' })
  const replayedOrderedInserts = await replayOperations(orderedBaseTree, {}, [orderedInsertBatch])
  assert.deepEqual(replayedOrderedInserts.tree.parent.children, ['left', 'second-at-slot', 'first-at-slot', 'right'])

  const keepChildrenBaseTree = {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: ['parent'] },
    parent: { data: { uid: 'parent', text: 'Parent' }, children: ['deleted-parent'] },
    'deleted-parent': { data: { uid: 'deleted-parent', text: 'Deleted parent' }, children: ['promoted-child'] },
    'promoted-child': { data: { uid: 'promoted-child', text: 'Promoted child' }, children: [] }
  }
  const keptChildrenHistory = await replayOperations(keepChildrenBaseTree, {}, [
    {
      room_key: 'history-unit',
      version: 2,
      operation_id: '00000000-0000-4000-8000-000000000014',
      operation_type: 'node.delete',
      payload: { uid: 'deleted-parent' },
      event: {
        type: 'node.deleted',
        payload: { uid: 'deleted-parent', parentUid: 'parent', removed: ['deleted-parent'], keepChildren: true, promoted: ['promoted-child'] }
      }
    }
  ])
  assert.equal(keptChildrenHistory.tree['deleted-parent'], undefined)
  assert.ok(keptChildrenHistory.tree['promoted-child'])
  assert.deepEqual(keptChildrenHistory.tree.parent.children, ['promoted-child'])

  const partialBatchId = '00000000-0000-4000-8000-000000000008'
  const partialBatchHistory = [
    {
      room_key: 'history-unit',
      version: 2,
      operation_id: partialBatchId,
      actor_id: 'history-user',
      operation_type: 'node.batch',
      payload: {
        ops: [
          { type: 'node.update', payload: { uid: 'parent', patch: { text: 'partial batch applied' } } },
          { type: 'node.update', payload: { uid: 'missing-node', patch: { text: 'failed item' } } }
        ],
        __mcpResult: {
          outcome: 'partial',
          count: 1,
          failed: 1,
          items: [
            { index: 0, status: 'applied', type: 'node.update' },
            { index: 1, status: 'failed', type: 'node.update', code: 'NODE_DELETED' }
          ]
        }
      },
      inverse_payload: {
        type: 'node.batch',
        payload: { ops: [{ type: 'node.update', payload: { uid: 'parent', patch: { text: 'Parent' } } }] }
      },
      event: {
        type: 'batch.applied',
        payload: {
          count: 1,
          events: [{ type: 'node.updated', payload: { uid: 'parent', patch: { text: 'partial batch applied' } } }]
        }
      }
    },
    {
      room_key: 'history-unit',
      version: 3,
      operation_id: '00000000-0000-4000-8000-000000000009',
      actor_id: 'history-user',
      operation_type: 'operation.undo',
      payload: { targetOperationId: partialBatchId },
      inverse_payload: {
        type: 'node.batch',
        payload: { ops: [{ type: 'node.update', payload: { uid: 'parent', patch: { text: 'partial batch applied' } } }] }
      },
      event: { type: 'node.updated', payload: { uid: 'parent', patch: { text: 'Parent' }, undoOf: partialBatchId } }
    },
    {
      room_key: 'history-unit',
      version: 4,
      operation_id: '00000000-0000-4000-8000-000000000010',
      actor_id: 'history-user',
      operation_type: 'operation.redo',
      payload: { targetOperationId: partialBatchId },
      event: { type: 'node.updated', payload: { uid: 'parent', patch: { text: 'partial batch applied' }, redoOf: partialBatchId } }
    }
  ]
  const undoneBatch = await replayOperations(baseTree, {}, partialBatchHistory.slice(0, 2))
  assert.equal(undoneBatch.tree.parent.data.text, 'Parent')
  const redoneBatch = await replayOperations(baseTree, {}, partialBatchHistory, {
    requireContinuous: true,
    fromRevision: 1
  })
  assert.equal(redoneBatch.tree.parent.data.text, 'partial batch applied')

  console.log('历史回放保留确定UID与批次成功集，支持确认过的SOP事件、原同级顺序、keepChildren及部分批次撤销/重做')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
