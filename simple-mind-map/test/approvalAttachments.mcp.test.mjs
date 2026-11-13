import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { registerApprovalTools } from '../bin/leaveWorkflow/mcp.mjs'
import wecomDisk from '../bin/leaveWorkflow/wecomDisk.js'
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

test('local MCP uploads WeCom file bytes and remote MCP asks for local download', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-wecom-cli-'))
  const script = path.join(dir, 'cli.mjs')
  const previous = process.env.WCPD_WECOM_CLI_PATH
  process.env.WCPD_WECOM_CLI_PATH = script
  t.after(async () => {
    if (previous === undefined) delete process.env.WCPD_WECOM_CLI_PATH
    else process.env.WCPD_WECOM_CLI_PATH = previous
    await fs.unlink(script)
    await fs.rmdir(dir)
  })
  await fs.writeFile(script, `
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
const [service, resource, method, jsonFlag, json, dirFlag, dir] = process.argv.slice(2)
assert.deepEqual([service, resource, method, jsonFlag, dirFlag],
  ['disk', 'files', 'download', '--json', '--output-dir'])
assert.equal(JSON.parse(json).url, 'https://drive.weixin.qq.com/s?k=test')
const file = path.join(dir, '候选人简历.pdf')
await fs.writeFile(file, '%PDF-1.7\\n%%EOF\\n')
console.log(JSON.stringify({ file_path: file, content_type: 'application/pdf' }))
`)

  const requestId = 'a0000000-0000-4000-8000-000000000001'
  const input = { request_id: requestId, field_key: 'resume', expected_revision: 1,
    operation_id: 'a0000000-0000-4000-8000-000000000002', source_url: 'https://drive.weixin.qq.com/s?k=test' }
  const calls = []
  function handler(downloadWecomFile) {
    let upload
    registerApprovalTools({ tool(name, _description, _schema, callback) {
      if (name === 'upload_approval_attachment') upload = callback
    } }, {
      downloadWecomFile, z, ok: data => data, fail: error => ({ code: error.code }),
      api: async (url, options) => {
        calls.push(url)
        if (url.endsWith('/attachment-ticket'))
          return { item: { storageScope: `approval-request:${requestId}`, fieldKey: 'resume' } }
        const body = JSON.parse(options.body)
        assert.equal(body.sourceUrl, undefined)
        assert.equal(body.fileName, '候选人简历.pdf')
        assert.equal(body.mimeType, 'application/pdf')
        assert.equal(Buffer.from(body.contentBase64, 'base64').toString(), '%PDF-1.7\n%%EOF\n')
        return { item: { attachmentId: 'saved' } }
      }
    })
    return upload
  }
  assert.deepEqual(await handler()(input), { code: 'WECOM_DISK_LOCAL_DOWNLOAD_REQUIRED' })
  assert.equal(calls.length, 1)
  assert.equal((await handler(wecomDisk.downloadWecomDiskFile)(input)).item.attachmentId, 'saved')
  assert(calls.at(-1).endsWith('/attachments'))
})
