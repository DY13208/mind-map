const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

const filename = path.resolve(__dirname, '../src/utils/nodeKnowledge.js')
const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const moduleRef = { exports: {} }
new Function('module', 'exports', code)(moduleRef, moduleRef.exports)
const {
  collectNodeKnowledge,
  buildVisionContent,
  knowledgeNeedsRemoteExtract,
  safeImageUrl
} = moduleRef.exports

const hugeDataUrl = `data:image/png;base64,${'A'.repeat(1500001)}`
const knowledge = collectNodeKnowledge({
  data: {
    note: '<b>采购说明</b>',
    image: hugeDataUrl,
    imageTitle: '报价单截图',
    attachmentName: '合同.pdf',
    attachmentUrl: 'https://example.test/contract.pdf',
    attachmentExtractedText: '付款条件：验收后 30 天。'
  }
})
assert.match(knowledge.text, /采购说明/)
assert.match(knowledge.text, /合同\.pdf/)
assert.match(knowledge.text, /付款条件/)
assert.ok(!knowledge.text.includes('AAAA'))
assert.ok(!knowledge.text.includes('base64'))
assert.equal(knowledge.images.length, 0)
assert.ok(knowledge.sources.some(s => s.type === 'attachment' && /付款条件/.test(s.extractedText)))

const valid = collectNodeKnowledge({
  data: { image: 'https://cdn.example.test/a.png', imageTitle: '示意图' }
})
assert.deepEqual(valid.images, ['https://cdn.example.test/a.png'])
assert.equal(knowledgeNeedsRemoteExtract(valid), true)
const content = buildVisionContent('上下文', valid.images, true)
assert.equal(content[0].type, 'text')
assert.equal(content[1].type, 'image_url')
assert.equal(buildVisionContent('上下文', valid.images, false), '上下文')

assert.equal(safeImageUrl('http://127.0.0.1/x.png'), '')
assert.equal(safeImageUrl('https://192.168.1.2/x.png'), '')

const withOcr = collectNodeKnowledge({
  data: {
    image: 'https://cdn.example.test/a.png',
    imageTitle: '发票',
    imageOcrText: '金额合计 1280 元'
  }
})
assert.match(withOcr.text, /金额合计/)
assert.equal(knowledgeNeedsRemoteExtract(withOcr), false)

const merged = collectNodeKnowledge(
  { data: { attachmentName: '说明.docx', attachmentStatus: 'pending' } },
  {
    extraSources: [
      {
        type: 'attachment',
        name: '说明.docx',
        status: 'ready',
        extractedText: '交付周期 15 个工作日'
      }
    ]
  }
)
assert.match(merged.text, /交付周期/)
assert.ok(!merged.text.includes('data:image'))

const plain = collectNodeKnowledge({ data: { text: '普通节点', note: '' } })
assert.equal(plain.text, '')
assert.equal(plain.sources.length, 0)

const truncated = collectNodeKnowledge(
  {
    data: {
      note: 'N'.repeat(5000),
      attachmentExtractedText: 'T'.repeat(5000)
    }
  },
  { maxTextChars: 200 }
)
assert.ok(truncated.truncated)
assert.match(truncated.text, /截断/)

console.log('Node knowledge collection tests passed')
