'use strict'

const assert = require('node:assert/strict')

async function main() {
  const {
    uploadAttachmentAndMountNode,
    AttachmentUploadWorkflowError
  } = await import('../simple-mind-map/bin/mcpAttachmentUpload.mjs')

  const targetUid = 'attachment-target'
  const attachment = {
    id: 'attachment-001',
    fileName: 'proof.txt',
    mimeType: 'text/plain',
    status: 'ready'
  }
  const persistedData = {
    uid: targetUid,
    attachmentId: attachment.id,
    attachmentUrl: '',
    attachmentName: attachment.fileName,
    attachmentMimeType: attachment.mimeType,
    attachmentStatus: 'ready'
  }

  function fakeApi(readback, uploadAttachment = attachment) {
    const calls = []
    const api = async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' })
      if (url.includes('/locate?')) {
        return {
          uid: targetUid,
          version: 1,
          nodes: {
            [targetUid]: { uid: targetUid, data: { uid: targetUid, text: 'target' } }
          }
        }
      }
      if (url.endsWith('/attachments') && options.method === 'POST') {
        return { attachment: uploadAttachment }
      }
      if (url.endsWith(`/nodes/${targetUid}`) && options.method === 'PATCH') {
        return { ok: true, uid: targetUid, version: 2 }
      }
      if (url.includes('/nodes?uids=')) return readback
      throw new Error(`Unexpected attachment workflow request: ${options.method || 'GET'} ${url}`)
    }
    return { api, calls }
  }

  async function run(readback, uploadAttachment = attachment) {
    const { api, calls } = fakeApi(readback, uploadAttachment)
    const result = await uploadAttachmentAndMountNode({
      api,
      roomKey: 'unit-room',
      nodeRef: targetUid,
      uploadInput: {
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        contentBase64: Buffer.from('attachment proof').toString('base64')
      },
      operationId: '00000000-0000-4000-8000-000000000001',
      delay: async () => {}
    })
    return { result, calls }
  }

  const actualApiArray = await run({
    version: 2,
    nodes: [{ uid: targetUid, data: persistedData }]
  })
  assert.equal(actualApiArray.result.persistence_verified, true)
  assert.equal(actualApiArray.result.node.version, 2)
  assert.equal(actualApiArray.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(actualApiArray.calls.filter(call => call.method === 'PATCH').length, 1)
  assert.equal(actualApiArray.calls.filter(call => call.method === 'GET' && call.url.includes('/nodes?')).length, 1)

  const legacyMap = await run({
    version: 2,
    nodes: { [targetUid]: { uid: targetUid, data: persistedData } }
  })
  assert.equal(legacyMap.result.persistence_verified, true)

  const processingToReady = await run({
    version: 2,
    nodes: [{ uid: targetUid, data: persistedData }]
  }, { ...attachment, status: 'processing' })
  assert.equal(processingToReady.result.persistence_verified, true)
  assert.equal(processingToReady.result.persisted_attachment.status, 'ready')

  for (const readback of [
    { version: 2, nodes: [] },
    { version: 2, nodes: [{ uid: 'different-node', data: persistedData }] },
    { version: 2, nodes: { [targetUid]: { uid: 'different-node', data: persistedData } } }
  ]) {
    await assert.rejects(
      run(readback),
      error => error instanceof AttachmentUploadWorkflowError &&
        error.code === 'ATTACHMENT_MOUNT_NOT_VERIFIED' &&
        error.details.current_attachment_id === null
    )
  }

  const missingStableField = await run({
    version: 2,
    nodes: [{ uid: targetUid, data: { ...persistedData, attachmentName: 'wrong-name.txt' } }]
  }).then(() => null, error => error)
  assert(missingStableField instanceof AttachmentUploadWorkflowError)
  assert.equal(missingStableField.code, 'ATTACHMENT_MOUNT_NOT_VERIFIED')
  assert.equal(missingStableField.details.current_attachment_id, attachment.id)
  assert.equal(missingStableField.details.mount_attempts, 1)

  process.stdout.write('PASS mcp attachment readback: API array + legacy UID map; missing/mismatched UID and stable fields fail closed; upload-once preserved\n')
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
