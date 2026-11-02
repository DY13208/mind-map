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
  const { resolveAttachmentUploadInput, remapAttachmentFilePath } = await load()

  assert.equal(
    remapAttachmentFilePath('C:\\Users\\demo\\WorkBuddy\\a\\b.pdf', {
      WORKBUDDY_HOST_DIR: 'C:/Users/demo/WorkBuddy'
    }),
    '/workbuddy/a/b.pdf'
  )
  assert.equal(
    remapAttachmentFilePath('/home/node/.openclaw/workspace/output/x.md'),
    '/app/output/x.md'
  )
  assert.equal(
    remapAttachmentFilePath('D:/良策0010/output/report.pdf'),
    '/app/output/report.pdf'
  )

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
  assert.equal(
    fromUrl.sourceUrl,
    'https://example.com/files/%E6%8A%A5%E5%91%8A.pdf'
  )
  assert.equal(fromUrl.contentBase64, undefined)

  const fromArchiveUrl = await resolveAttachmentUploadInput({
    source_url: 'https://example.com/files/%E8%B5%84%E6%96%99.tar.gz'
  })
  assert.equal(fromArchiveUrl.fileName, '资料.tar.gz')
  assert.equal(fromArchiveUrl.sourceUrl, 'https://example.com/files/%E8%B5%84%E6%96%99.tar.gz')

  const fromB64 = await resolveAttachmentUploadInput({
    node: 'n2',
    file_name: 'note.md',
    content_base64: Buffer.from('# hi', 'utf8').toString('base64'),
    mime_type: 'text/markdown'
  })
  assert.equal(fromB64.fileName, 'note.md')
  assert.equal(fromB64.mimeType, 'text/markdown')
  assert.ok(fromB64.contentBase64)

  const archiveBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
  const fromArchiveB64 = await resolveAttachmentUploadInput({
    file_name: '加密资料.7z',
    content_base64: archiveBytes.toString('base64')
  })
  assert.deepEqual(Buffer.from(fromArchiveB64.contentBase64, 'base64'), archiveBytes)
  assert.equal(fromArchiveB64.fileName, '加密资料.7z')

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

  const archiveTmp = path.join(os.tmpdir(), `mcp-att-${Date.now()}.tar.xz`)
  fs.writeFileSync(archiveTmp, archiveBytes)
  try {
    const fromArchivePath = await resolveAttachmentUploadInput({ file_path: archiveTmp })
    assert.equal(fromArchivePath.fileName, path.basename(archiveTmp))
    assert.deepEqual(Buffer.from(fromArchivePath.contentBase64, 'base64'), archiveBytes)
  } finally {
    fs.unlinkSync(archiveTmp)
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
