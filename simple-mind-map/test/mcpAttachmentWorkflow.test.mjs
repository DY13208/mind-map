import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  attachmentMetaForNode,
  uploadAttachmentAndMountNode
} from '../bin/mcpAttachmentUpload.mjs'

const require = createRequire(import.meta.url)
const Y = require('yjs')
const mindDoc = require('../bin/mindDoc.js')
const { applyNodeCommand, dataFields } = require('../bin/roomCommands.js')
const { withExpectedCondition } = require('../bin/nodeUpdateExpected.js')

const ROOM = 'room-test'
const UID = 'node-1'
const OPERATION_ID = 'mcp-attachment-operation-test'

function makeNode(data = {}) {
  return {
    uid: UID,
    data: {
      uid: UID,
      attachmentId: 'old-attachment',
      attachmentUrl: '',
      attachmentName: 'old.pdf',
      attachmentMimeType: 'application/pdf',
      attachmentStatus: 'ready',
      __fv: { attachment: 7 },
      ...data
    }
  }
}

function httpError(statusCode, code = `HTTP_${statusCode}`) {
  const error = new Error(`HTTP ${statusCode}`)
  error.statusCode = statusCode
  error.code = code
  return error
}

function testApi({
  node = makeNode(),
  version = 12,
  attachment = {
    id: 'new-attachment',
    fileName: 'new.pdf',
    mimeType: 'application/pdf',
    status: 'processing'
  },
  onPatch = async (_body, _attempt, currentNode) => {
    currentNode.data = { ...currentNode.data, ..._body }
    return { ok: true }
  },
  onPost = async () => ({ ok: true, attachment }),
  onRead = async (currentNode, currentVersion) => ({
    version: currentVersion + 1,
    nodes: { [UID]: currentNode }
  })
} = {}) {
  const calls = []
  let patchCount = 0
  let postCount = 0

  const api = async (path, options = {}) => {
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ path, method, body })

    if (path.includes('/locate?')) {
      return {
        uid: UID,
        version,
        nodes: { [UID]: currentNode }
      }
    }
    if (path.endsWith('/attachments') && method === 'POST') {
      postCount += 1
      return onPost(body, postCount, currentNode)
    }
    if (path.endsWith(`/nodes/${UID}`) && method === 'PATCH') {
      patchCount += 1
      return onPatch(body, patchCount, currentNode)
    }
    if (path.includes('/nodes?uids=')) {
      return onRead(currentNode, version)
    }
    throw new Error(`Unexpected API request: ${method} ${path}`)
  }

  let currentNode = node
  return {
    api,
    calls,
    get currentNode() {
      return currentNode
    },
    get patchCount() {
      return patchCount
    },
    get postCount() {
      return postCount
    },
    setNodeData(data) {
      currentNode.data = data
    }
  }
}

const ATTACHMENT_FIELDS = [
  'attachmentUrl',
  'attachmentName',
  'attachmentId',
  'attachmentMimeType',
  'attachmentStatus',
  'attachmentError',
  'attachmentExtractedText',
  'attachmentProgress'
]

function createYDocWorkflowApi({ afterUpload } = {}) {
  const doc = new Y.Doc()
  const initialData = {
    uid: UID,
    text: '目标节点',
    attachmentUrl: '',
    attachmentName: 'old.pdf',
    attachmentId: 'old-attachment',
    attachmentMimeType: 'application/pdf',
    attachmentStatus: 'ready',
    attachmentError: '',
    attachmentExtractedText: '旧正文',
    attachmentProgress: 100,
    __fv: { attachment: 8 }
  }
  mindDoc.applyObjectToDoc(
    doc,
    {
      root: {
        isRoot: true,
        data: { uid: 'root', text: '根节点' },
        children: [UID]
      },
      [UID]: {
        isRoot: false,
        data: initialData,
        children: []
      }
    },
    { replace: true }
  )

  let version = 20
  let postCount = 0
  let patchCount = 0
  const calls = []

  function applyUpdate(body, operationVersion = version + 1) {
    const patch = dataFields(body)
    const payload = withExpectedCondition(body, {
      uid: UID,
      parentUid: 'root',
      index: 0,
      patch,
      confirm_sop_change: body.confirm_sop_change === true
    })
    const result = applyNodeCommand(
      doc,
      { type: 'node.update', payload },
      { version: operationVersion }
    )
    version = Math.max(version, operationVersion)
    return result
  }

  const api = async (path, options = {}) => {
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ path, method, body })

    if (path.includes('/locate?')) {
      const nodes = mindDoc.readObject(doc)
      return {
        uid: UID,
        version,
        nodes: { [UID]: nodes[UID] }
      }
    }
    if (path.endsWith('/attachments') && method === 'POST') {
      postCount += 1
      const result = {
        ok: true,
        attachment: {
          id: 'workflow-attachment',
          fileName: 'workflow.pdf',
          mimeType: 'application/pdf',
          status: 'processing',
          extractedText: ''
        }
      }
      if (afterUpload) afterUpload({ doc, applyUpdate, result })
      return result
    }
    if (path.endsWith(`/nodes/${UID}`) && method === 'PATCH') {
      patchCount += 1
      const result = applyUpdate(body)
      return {
        ok: true,
        uid: UID,
        version,
        event: result.event
      }
    }
    if (path.includes('/nodes?uids=')) {
      const nodes = mindDoc.readObject(doc)
      return {
        version,
        nodes: { [UID]: nodes[UID] }
      }
    }
    throw new Error(`Unexpected API request: ${method} ${path}`)
  }

  return {
    api,
    doc,
    calls,
    get version() {
      return version
    },
    get postCount() {
      return postCount
    },
    get patchCount() {
      return patchCount
    },
    readNode() {
      return mindDoc.readObject(doc)[UID]
    }
  }
}

async function main() {
  {
    const mock = testApi({
      onPatch: async (body, attempt, node) => {
        if (attempt === 1) throw httpError(503)
        // The parser can finish between the upload response and authoritative
        // readback, changing processing metadata while preserving attachment identity.
        node.data = {
          ...node.data,
          attachmentId: body.attachmentId,
          attachmentUrl: body.attachmentUrl,
          attachmentName: body.attachmentName,
          attachmentMimeType: 'application/pdf',
          attachmentStatus: 'ready',
          attachmentError: '',
          attachmentExtractedText: 'parsed after upload',
          attachmentProgress: 100
        }
        return { ok: true, uid: UID, version: 13, event: { payload: {} } }
      }
    })

    const result = await uploadAttachmentAndMountNode({
      api: mock.api,
      roomKey: ROOM,
      nodeRef: UID,
      uploadInput: { fileName: 'new.pdf', contentBase64: 'AQID' },
      operationId: OPERATION_ID,
      delay: async () => {}
    })

    assert.equal(result.ok, true)
    assert.equal(result.node.uid, UID)
    assert.equal(result.node.version, 13)
    assert.equal(result.persistence_verified, true)
    assert.deepEqual(result.persisted_attachment, {
      id: 'new-attachment',
      url: '',
      name: 'new.pdf',
      status: 'ready'
    })
    assert.match(result.message, /工具栏/)
    assert.equal(mock.postCount, 1, 'mount retries must not repeat the upload')
    assert.equal(mock.patchCount, 2)

    const locateIndex = mock.calls.findIndex(call => call.path.includes('/locate?'))
    const postIndex = mock.calls.findIndex(call => call.method === 'POST')
    const patchCalls = mock.calls.filter(call => call.method === 'PATCH')
    assert.ok(locateIndex >= 0 && locateIndex < postIndex)
    assert.equal(patchCalls.length, 2)
    for (const call of patchCalls) {
      assert.equal(call.body.operationId, OPERATION_ID)
      assert.equal(call.body.baseVersion, 12)
      assert.deepEqual(call.body.expected, {
        attachmentId: 'old-attachment',
        attachmentUrl: '',
        attachmentName: 'old.pdf',
        '__fv.attachment': 7
      })
    }
  }

  {
    const calls = []
    const api = async (path, options = {}) => {
      calls.push({ path, method: options.method || 'GET' })
      if (path.includes('/locate?')) throw httpError(404, 'NODE_NOT_FOUND')
      throw new Error(`Unexpected API call ${path}`)
    }
    await assert.rejects(
      () =>
        uploadAttachmentAndMountNode({
          api,
          roomKey: ROOM,
          nodeRef: UID,
          uploadInput: { fileName: 'new.pdf' },
          operationId: OPERATION_ID
        }),
      error => {
        assert.equal(error.code, 'ATTACHMENT_NODE_LOCATE_FAILED')
        assert.equal(error.details.phase, 'locate')
        return true
      }
    )
    assert.equal(calls.filter(call => call.method === 'POST').length, 0)
  }

  {
    let posts = 0
    const api = async path => {
      if (path.includes('/locate?')) {
        return {
          uid: UID,
          version: 1,
          nodes: { [UID]: { uid: UID, data: { uid: 'different-uid' } } }
        }
      }
      if (path.endsWith('/attachments')) posts += 1
      throw new Error('unexpected call')
    }
    await assert.rejects(
      () =>
        uploadAttachmentAndMountNode({
          api,
          roomKey: ROOM,
          nodeRef: UID,
          uploadInput: { fileName: 'new.pdf' },
          operationId: OPERATION_ID
        }),
      error => error.code === 'ATTACHMENT_NODE_UID_INVALID'
    )
    assert.equal(posts, 0)
  }

  {
    let posts = 0
    const api = async path => {
      if (path.includes('/locate?')) {
        const node = makeNode()
        return { uid: UID, version: null, nodes: { [UID]: node } }
      }
      if (path.endsWith('/attachments')) posts += 1
      throw new Error('unexpected call')
    }
    await assert.rejects(
      () =>
        uploadAttachmentAndMountNode({
          api,
          roomKey: ROOM,
          nodeRef: UID,
          uploadInput: { fileName: 'new.pdf' },
          operationId: OPERATION_ID
        }),
      error => error.code === 'ATTACHMENT_NODE_REVISION_INVALID'
    )
    assert.equal(posts, 0)
  }

  {
    // A deduplicated upload can return an ID already present on the node. A
    // permission rejection must still be reported as failure, never inferred
    // as a successful write from matching readback fields.
    const existing = makeNode({ attachmentName: 'same.pdf' })
    const mock = testApi({
      node: existing,
      attachment: {
        id: 'old-attachment',
        fileName: 'same.pdf',
        status: 'ready'
      },
      onPatch: async () => {
        throw httpError(403, 'FORBIDDEN')
      }
    })
    await assert.rejects(
      () =>
        uploadAttachmentAndMountNode({
          api: mock.api,
          roomKey: ROOM,
          nodeRef: UID,
          uploadInput: { fileName: 'same.pdf' },
          operationId: OPERATION_ID
        }),
      error => {
        assert.equal(error.code, 'ATTACHMENT_MOUNT_FAILED')
        assert.equal(error.details.attachment_id, 'old-attachment')
        assert.equal(error.details.cause_status_code, 403)
        return true
      }
    )
    assert.equal(mock.patchCount, 1)
    assert.equal(mock.postCount, 1)
  }

  {
    // The first PATCH committed but its response was lost. Before the retry,
    // another editor replaces the attachment. Idempotent replay with the same
    // operationId must not reapply this upload over that newer value.
    const appliedOperations = new Set()
    const mock = testApi({
      onPatch: async (body, attempt, node) => {
        assert.equal(body.operationId, OPERATION_ID)
        if (appliedOperations.has(body.operationId)) {
          return { ok: true, duplicate: true, uid: UID, version: 13 }
        }
        appliedOperations.add(body.operationId)
        node.data = { ...node.data, ...body }
        if (attempt === 1) {
          node.data = {
            ...node.data,
            attachmentId: 'other-editors-attachment',
            attachmentName: 'other.pdf',
            attachmentStatus: 'ready'
          }
          const error = new Error('socket timed out after commit')
          error.code = 'ETIMEDOUT'
          throw error
        }
        return { ok: true, uid: UID, version: 13 }
      }
    })

    await assert.rejects(
      () =>
        uploadAttachmentAndMountNode({
          api: mock.api,
          roomKey: ROOM,
          nodeRef: UID,
          uploadInput: { fileName: 'new.pdf' },
          operationId: OPERATION_ID,
          delay: async () => {}
        }),
      error => {
        assert.equal(error.code, 'ATTACHMENT_MOUNT_NOT_VERIFIED')
        assert.equal(error.details.current_attachment_id, 'other-editors-attachment')
        return true
      }
    )
    assert.equal(mock.postCount, 1)
    assert.equal(mock.patchCount, 2)
    assert.equal(mock.currentNode.data.attachmentId, 'other-editors-attachment')
    assert.deepEqual([...appliedOperations], [OPERATION_ID])
  }

  {
    // Even when every PATCH response is lost, authoritative readback can
    // confirm the write. Keep the historical node.uid/version response shape.
    const mock = testApi({
      onPatch: async (body, _attempt, node) => {
        node.data = { ...node.data, ...body }
        const error = new Error('socket timed out after commit')
        error.code = 'ETIMEDOUT'
        throw error
      }
    })
    const result = await uploadAttachmentAndMountNode({
      api: mock.api,
      roomKey: ROOM,
      nodeRef: UID,
      uploadInput: { fileName: 'new.pdf' },
      operationId: OPERATION_ID,
      maxMountAttempts: 1,
      delay: async () => {}
    })
    assert.equal(result.node.ok, true)
    assert.equal(result.node.uid, UID)
    assert.equal(result.node.version, 13)
    assert.equal(result.node.verifiedByReadback, true)
    assert.equal(result.attachment.id, 'new-attachment')
    assert.equal(result.content_url, `/api/files/${ROOM}/attachments/new-attachment/content`)
    assert.equal(result.persistence_verified, true)
  }

  {
    let posts = 0
    let patches = 0
    const delegate = testApi()
    const api = async (path, options = {}) => {
      if (path.endsWith('/attachments') && options.method === 'POST') {
        posts += 1
        const error = new Error('upload response timed out')
        error.code = 'ETIMEDOUT'
        throw error
      }
      if (path.endsWith(`/nodes/${UID}`) && options.method === 'PATCH') patches += 1
      return delegate.api(path, options)
    }
    await assert.rejects(
      () =>
        uploadAttachmentAndMountNode({
          api,
          roomKey: ROOM,
          nodeRef: UID,
          uploadInput: { fileName: 'new.pdf' },
          operationId: OPERATION_ID
        }),
      error => {
        assert.equal(error.code, 'ATTACHMENT_UPLOAD_FAILED')
        assert.equal(error.details.upload_outcome, 'unknown')
        return true
      }
    )
    assert.equal(posts, 1)
    assert.equal(patches, 0)
  }

  {
    const mock = createYDocWorkflowApi()
    const result = await uploadAttachmentAndMountNode({
      api: mock.api,
      roomKey: ROOM,
      nodeRef: UID,
      uploadInput: { fileName: 'workflow.pdf', contentBase64: 'AQID' },
      operationId: OPERATION_ID
    })
    const persistedData = mock.readNode().data
    const expectedPatch = attachmentMetaForNode(result.attachment)

    assert.equal(result.persistence_verified, true)
    assert.equal(mock.postCount, 1)
    assert.equal(mock.patchCount, 1)
    for (const key of ATTACHMENT_FIELDS) {
      assert.equal(persistedData[key], expectedPatch[key], `${key} should persist`)
    }
    for (const key of [
      'expected',
      'operationId',
      'baseVersion',
      'confirm_sop_change'
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(persistedData, key),
        false,
        `${key} is command metadata and must not leak into node data`
      )
    }
    assert.equal(persistedData.__fv.attachment, 21)
  }

  {
    const mock = createYDocWorkflowApi({
      afterUpload: ({ applyUpdate }) => {
        // Another editor replaces the node attachment after locate and upload,
        // before this workflow reaches its compare-and-set PATCH.
        applyUpdate({
          attachmentId: 'other-editors-attachment',
          attachmentUrl: '',
          attachmentName: 'other-editor.pdf',
          attachmentMimeType: 'application/pdf',
          attachmentStatus: 'ready',
          attachmentError: '',
          attachmentExtractedText: 'other editor content',
          attachmentProgress: 100
        })
      }
    })

    await assert.rejects(
      () =>
        uploadAttachmentAndMountNode({
          api: mock.api,
          roomKey: ROOM,
          nodeRef: UID,
          uploadInput: { fileName: 'workflow.pdf', contentBase64: 'AQID' },
          operationId: OPERATION_ID
        }),
      error => {
        assert.equal(error.code, 'ATTACHMENT_MOUNT_FAILED')
        assert.equal(error.statusCode, 409)
        assert.equal(error.details.cause_code, 'REPLACE_CONFLICT')
        assert.equal(error.details.attachment_id, 'workflow-attachment')
        assert.equal(
          error.details.current_attachment_id,
          'other-editors-attachment'
        )
        return true
      }
    )

    const persistedData = mock.readNode().data
    assert.equal(mock.postCount, 1)
    assert.equal(mock.patchCount, 1)
    assert.equal(persistedData.attachmentId, 'other-editors-attachment')
    assert.equal(persistedData.attachmentName, 'other-editor.pdf')
    assert.equal(persistedData.attachmentExtractedText, 'other editor content')
    assert.equal(persistedData.__fv.attachment, 21)
  }

  console.log('mcpAttachmentWorkflow tests passed (10 scenarios)')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
