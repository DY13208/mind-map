/**
 * Unit tests for MCP upload_attachment input resolution.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

async function load() {
  return import('../bin/mcpAttachmentUpload.mjs')
}

async function main() {
  const { resolveAttachmentUploadInput } = await load()

  await assert.rejects(
    () => resolveAttachmentUploadInput({}),
    /file_path|content_base64|source_url/
  )

  const fromUrl = await resolveAttachmentUploadInput({
    node: 'n1',
    source_url: 'https://example.com/files/%E6%8A%A5%E5%91%8A.pdf'
  })
  assert.equal(fromUrl.nodeUid, 'n1')
  assert.equal(fromUrl.fileName, '报告.pdf')
  assert.equal(fromUrl.sourceUrl, 'https://example.com/files/%E6%8A%A5%E5%91%8A.pdf')
  assert.equal(fromUrl.contentBase64, undefined)

  const fromB64 = await resolveAttachmentUploadInput({
    node: 'n2',
    file_name: 'note.md',
    content_base64: Buffer.from('# hi', 'utf8').toString('base64'),
    mime_type: 'text/markdown'
  })
  assert.equal(fromB64.fileName, 'note.md')
  assert.equal(fromB64.mimeType, 'text/markdown')
  assert.ok(fromB64.contentBase64)

  const tmp = path.join(os.tmpdir(), `mcp-att-${Date.now()}.txt`)
  fs.writeFileSync(tmp, 'hello-attachment', 'utf8')
  try {
    const fromPath = await resolveAttachmentUploadInput({
      node: 'n3',
      file_path: tmp
    })
    assert.equal(fromPath.fileName, path.basename(tmp))
    assert.equal(
      Buffer.from(fromPath.contentBase64, 'base64').toString('utf8'),
      'hello-attachment'
    )
  } finally {
    fs.unlinkSync(tmp)
  }

  await assert.rejects(
    () =>
      resolveAttachmentUploadInput({
        file_path: path.join(os.tmpdir(), 'mcp-att-missing-nope.txt')
      }),
    /不存在|无法读取/
  )

  console.log('mcpUploadAttachment tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
