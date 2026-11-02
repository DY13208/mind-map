import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { registerApprovalTools } from '../bin/leaveWorkflow/mcp.mjs'
import { saveTicketBytes, getUploadTicket, discardUploadTicket } from '../bin/mcpUploadTickets.mjs'

test('dedicated MCP tools bind the direct-upload ticket to one request and field, never a map node', async () => {
  const tools = new Map()
  const calls = []
  const requestId = 'a0000000-0000-4000-8000-000000000001'
  let denied = false
  registerApprovalTools({ tool(name, description, schema, handler) { tools.set(name, { schema, handler }) } }, {
    z, ok: data => data, fail: error => ({ isError: true, message: error.message }),
    api: async (path, options) => {
      calls.push({ path, options })
      if (denied) throw new Error('无权上传本次申请')
      const body = JSON.parse(options.body)
      if (path.endsWith('/attachment-ticket')) return { item: { storageScope: `approval-request:${requestId}`, fieldKey: 'resume' } }
      assert.equal(path, `/api/workflow-requests/${requestId}/attachments`)
      assert.equal(body.nodeUid, undefined)
      assert.equal(body.roomKey, undefined)
      assert.equal(body.fieldKey, 'resume')
      assert.equal(Buffer.from(body.contentBase64, 'base64').toString(), '简历附件')
      return { item: { attachmentId: 'saved', revision: 2 } }
    }
  })
  assert(tools.has('upload_approval_attachment'))
  assert(tools.has('create_approval_upload_ticket'))
  assert(!tools.has('upload_attachment'), 'node attachment tool is not registered by the approval module')
  const ticketTool = tools.get('create_approval_upload_ticket')
  const uploadTool = tools.get('upload_approval_attachment')
  const ticket = await ticketTool.handler({ request_id: requestId, field_key: '待入职人员简历', file_name: 'resume.txt' })
  try {
    assert.equal(ticket.field_key, 'resume')
    assert.equal(ticket.max_bytes, 20 * 1024 * 1024)
    assert.equal(getUploadTicket(ticket.upload_id).roomKey, `approval-request:${requestId}`)
    assert.equal(getUploadTicket(ticket.upload_id).nodeRef, 'resume')
    assert.equal((await saveTicketBytes(ticket.upload_id, Buffer.from('简历附件'))).ok, true)
    const input = { request_id: requestId, field_key: 'resume', upload_id: ticket.upload_id, expected_revision: 1, operation_id: 'a0000000-0000-4000-8000-000000000002' }
    denied = true
    const rejected = await uploadTool.handler(input)
    assert.equal(rejected.isError, true)
    assert.match(rejected.message, /无权/)
    assert(getUploadTicket(ticket.upload_id), 'a denied or unknown result does not destroy the retry ticket')
    denied = false
    const result = await uploadTool.handler(input)
    assert.equal(result.item.attachmentId, 'saved')
    assert.equal(getUploadTicket(ticket.upload_id), null, 'successful registration consumes the ticket')
    assert(calls.every(c => !c.path.includes('/nodes') && !c.path.includes('/api/files/')))
    const invalid = await uploadTool.handler({ ...input, file_path: '/unused-file' })
    assert.equal(invalid.isError, true)
    assert.match(invalid.message, /只能提供一种/)
  } finally { discardUploadTicket(ticket.upload_id) }
})
