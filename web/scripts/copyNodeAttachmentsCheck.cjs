const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
async function main() {
  const file = path.resolve(__dirname, '../../web/src/utils/copyNodeAttachments.js')
  assert.ok(fs.existsSync(file), 'cross-room attachment transfer is missing')
  const calls = []
  const waitForAttachmentReady = async (room, id) => { calls.push(['ready', room, id]); return { id, fileName: '资料.pdf', mimeType: 'application/pdf', status: 'ready', extractedText: '目标房间附件摘要' } }
  const context = vm.createContext({ File, fetchNodeAttachmentContent: async (room, id) => { calls.push(['read', room, id]); return { buffer: new Uint8Array([1, 2, 3]).buffer } }, getNodeAttachment: async () => ({ attachment: { fileName: '资料.pdf', mimeType: 'application/pdf' } }), uploadNodeAttachment: async (room, body) => { calls.push(['upload', room]); assert.deepEqual(Array.from(new Uint8Array(await body.file.arrayBuffer())), [1, 2, 3]); return { attachment: { id: 'destination-file', fileName: '资料.pdf', mimeType: 'application/pdf', status: 'queued' } } } })
  vm.runInContext(fs.readFileSync(file, 'utf8').replace(/import[\s\S]*?from ['"][^'"]+['"]/g, '').replace(/export /g, '') + '\nglobalThis.transfer = copyNodeAttachments', context)
  context.waitForAttachmentReady = waitForAttachmentReady
  const original = { simpleMindMap: true, sourceRoom: 'A', data: [{ data: { text: '负责人', attachmentId: 'source-file', attachmentName: '资料.pdf', hyperlink: 'https://example.com' }, children: [{ data: { attachmentId: 'source-file' }, children: [] }] }] }
  const copied = await context.transfer(original, 'B')
  assert.equal(copied[0].data.attachmentId, 'destination-file')
  assert.equal(copied[0].children[0].data.attachmentId, 'destination-file')
  assert.equal(copied[0].data.hyperlink, 'https://example.com')
  assert.equal(original.data[0].data.attachmentId, 'source-file')
  assert.deepEqual(calls, [['read', 'A', 'source-file'], ['upload', 'B'], ['ready', 'B', 'destination-file']])
  assert.equal(copied[0].data.attachmentStatus, 'ready')
  assert.equal(copied[0].data.attachmentExtractedText, '目标房间附件摘要', 'compact cross-room paste restores summaries from the destination attachment')
  assert.equal(copied[0].children[0].data.attachmentExtractedText, '目标房间附件摘要')
  calls.length = 0
  const sameRoom = await context.transfer(original, 'A')
  assert.equal(calls.length, 0, 'same-map paste does not upload')
  assert.equal(sameRoom[0].data.attachmentId, 'source-file')
  assert.equal(sameRoom[0].data.attachmentExtractedText, undefined, 'same-room paste can defer summary reading')
  context.waitForAttachmentReady = async () => ({ id: 'destination-file', status: 'failed', errorMessage: 'extraction failed' })
  await assert.rejects(context.transfer(original, 'B'), /extraction failed/)
  context.fetchNodeAttachmentContent = async () => { throw new Error('denied') }
  await assert.rejects(context.transfer(original, 'B'), /denied/)
  console.log('PASS cross-room attachment bytes/IDs, deduplication, source preservation, same-room copy, failure propagation')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
