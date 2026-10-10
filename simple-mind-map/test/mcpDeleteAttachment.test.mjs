import assert from 'node:assert/strict'
import { deleteNodeAttachment } from '../bin/mcpAttachmentDelete.mjs'

async function main() {
  const calls = []
  const response = {
    ok: true,
    detached: true,
    retained: true,
    revision: 18,
    node: { uid: 'node-9', data: {} }
  }
  const result = await deleteNodeAttachment({
    api: async (path, options = {}) => {
      calls.push({ path, options })
      if (path.includes('/locate?')) return { uid: 'node-9' }
      return response
    },
    roomKey: 'room / demo',
    node: '合同流程 / 审批',
    attachmentId: 'att/1',
    baseVersion: 17,
    confirmSopChange: true
  })
  assert.equal(result, response)
  assert.deepEqual(calls, [
    {
      path: '/api/files/room%20%2F%20demo/locate?uid=%E5%90%88%E5%90%8C%E6%B5%81%E7%A8%8B%20%2F%20%E5%AE%A1%E6%89%B9',
      options: { timeoutMs: 15000 }
    },
    {
      path: '/api/files/room%20%2F%20demo/attachments/att%2F1?node_uid=node-9&base_version=17&confirm_sop_change=1',
      options: { method: 'DELETE', timeoutMs: 30000 }
    }
  ])

  let deleteCalled = false
  await assert.rejects(
    () =>
      deleteNodeAttachment({
        api: async path => {
          if (path.includes('/locate?')) {
            const err = new Error('有 2 个同名节点')
            err.code = 'AMBIGUOUS_NODE'
            throw err
          }
          deleteCalled = true
        },
        roomKey: 'room-demo',
        node: '合同',
        attachmentId: 'att-1',
        baseVersion: 17
      }),
    error => error.code === 'AMBIGUOUS_NODE'
  )
  assert.equal(deleteCalled, false, 'ambiguous node must never be deleted')

  await assert.rejects(
    () =>
      deleteNodeAttachment({
        api: async () => ({ uid: 'node-1' }),
        roomKey: 'room-demo',
        node: 'node-1',
        attachmentId: 'att-1'
      }),
    error => error.code === 'INVALID_BASE_VERSION'
  )

  console.log('mcpDeleteAttachment tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
