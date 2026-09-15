const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

function loadUtils() {
  const filename = path.resolve(__dirname, '../src/utils/nodeAttachmentPreview.js')
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const moduleRef = { exports: {} }
  new Function('module', 'exports', 'TextDecoder', code)(
    moduleRef,
    moduleRef.exports,
    TextDecoder
  )
  return moduleRef.exports
}

const {
  attachmentPreviewKind,
  decodeAttachmentText,
  formatAttachmentText,
  formatOfficePreviewText,
  safeMarkdownSource
} = loadUtils()

assert.equal(attachmentPreviewKind('合同.pdf'), 'pdf')
assert.equal(attachmentPreviewKind('截图.PNG'), 'image')
assert.equal(attachmentPreviewKind('说明.md'), 'markdown')
assert.equal(attachmentPreviewKind('数据.json'), 'json')
assert.equal(attachmentPreviewKind('报价.xlsx'), 'office')
assert.equal(
  formatOfficePreviewText('标题,,,\n甲,乙,,\n,,,', '报价.xlsx'),
  '标题\n甲,乙'
)
assert.equal(attachmentPreviewKind('archive.zip'), 'unsupported')

assert.equal(decodeAttachmentText(Buffer.from('中文 UTF-8', 'utf8')), '中文 UTF-8')
assert.equal(
  decodeAttachmentText(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('带 BOM', 'utf8')])),
  '带 BOM'
)

const utf16le = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from('UTF-16 LE 中文', 'utf16le')
])
assert.equal(decodeAttachmentText(utf16le), 'UTF-16 LE 中文')

const utf16beText = 'UTF-16 BE 中文'
const utf16be = Buffer.alloc(utf16beText.length * 2 + 2)
utf16be[0] = 0xfe
utf16be[1] = 0xff
for (let index = 0; index < utf16beText.length; index += 1) {
  utf16be.writeUInt16BE(utf16beText.charCodeAt(index), index * 2 + 2)
}
assert.equal(decodeAttachmentText(utf16be), utf16beText)

assert.equal(decodeAttachmentText(Buffer.from('d6d0cec4', 'hex')), '中文')
assert.throws(() => decodeAttachmentText(Buffer.from([0, 1, 2, 3])), /二进制内容/)
assert.equal(
  formatAttachmentText(Buffer.from('{"名称":"合同","金额":9000}', 'utf8'), 'json'),
  '{\n  "名称": "合同",\n  "金额": 9000\n}'
)
assert.equal(safeMarkdownSource('# 标题\n<script>alert(1)</script>'), '# 标题\n&lt;script&gt;alert(1)&lt;/script&gt;')

console.log('Node attachment preview decoding tests passed')
