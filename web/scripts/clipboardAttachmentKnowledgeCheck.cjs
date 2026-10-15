const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..')

async function main() {
  const requests = []
  const context = vm.createContext({
    console: { warn() {} },
    roomFromLocation: () => 'room-a',
    apiRequest: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) })
      return { sources: [{ type: 'attachment', name: '资料.pdf', attachmentId: 'file-a', status: 'ready', extractedText: '按附件 ID 读取的内容' }] }
    }
  })
  for (const file of ['web/src/utils/nodeKnowledge.js', 'web/src/utils/nodeAttachmentApi.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
      .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm, '')
      .replace(/export /g, '')
    vm.runInContext(source, context, { filename: file })
  }
  vm.runInContext('globalThis.enrich = enrichNodeKnowledge', context)
  const node = { data: { uid: 'pasted-node', text: '附件节点', attachmentId: 'file-a', attachmentName: '资料.pdf', attachmentStatus: 'ready' } }
  const before = JSON.stringify(node)
  const result = await context.enrich(null, node)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/api/files/room-a/knowledge/ensure')
  assert.equal(requests[0].body.sources[0].attachmentId, 'file-a')
  assert.equal(requests[0].body.sources[0].nodeUid, 'pasted-node')
  assert.ok(result.knowledge.text.includes('按附件 ID 读取的内容'), 'AI context recovers summaries omitted from same-room and cross-page clipboard copies')
  assert.equal(JSON.stringify(node), before, 'on-demand knowledge reads do not mutate pasted nodes')
  requests.length = 0
  const legacy = { data: { ...node.data, attachmentExtractedText: '旧版携带的摘要' } }
  const legacyResult = await context.enrich(null, legacy)
  assert.equal(requests.length, 0, 'legacy clipboard summaries remain usable locally')
  assert.ok(legacyResult.knowledge.text.includes('旧版携带的摘要'))
  context.apiRequest = async () => { throw Error('attachment access denied') }
  const failed = await context.enrich(null, node)
  assert.equal(failed.error.message, 'attachment access denied', 'existing knowledge read errors remain visible to callers')
  assert.equal(failed.knowledge.sources[0].attachmentId, 'file-a', 'failed reads retain the attachment reference')
  console.log('PASS pasted attachment knowledge: ID-based retrieval, legacy summaries, read failure propagation')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
