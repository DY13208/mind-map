const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const compiler = require('vue-template-compiler')

const webRoot = path.resolve(__dirname, '..')

function loadDisplayHelpers() {
  const filename = path.join(webRoot, 'src/utils/conflictDraftDisplay.js')
  const source = fs.readFileSync(filename, 'utf8')
  const context = { module: { exports: {} }, exports: {} }
  const executable = source.replace(/^export /gm, '') +
    '\nmodule.exports = { formatConflictText, isConflictRichText }'
  vm.runInNewContext(executable, context, { filename })
  return context.module.exports
}

function loadPanel(helpers) {
  const filename = path.join(
    webRoot,
    'src/pages/Edit/components/ConflictDraftPanel.vue'
  )
  const parsed = compiler.parseComponent(fs.readFileSync(filename, 'utf8'))
  assert.ok(parsed && parsed.template && parsed.script, 'panel SFC must parse')
  assert.deepStrictEqual(compiler.compile(parsed.template.content).errors, [])
  assert.ok(!/\bv-html\b/.test(parsed.template.content), 'panel must render as escaped text')

  const context = {
    formatConflictText: helpers.formatConflictText,
    isConflictRichText: helpers.isConflictRichText
  }
  const script = parsed.script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace('export default', 'component =')
  vm.runInNewContext(script, context, { filename })
  return context.component
}

const helpers = loadDisplayHelpers()
const component = loadPanel(helpers)
const t = key => ({
  'nodeHyperlink.link': '链接',
  'nodeHyperlink.name': '链接名称'
}[key] || key)

function format(values, fields, source) {
  return component.methods.formatValues.call({ $t: t }, values, fields, source)
}

const rawRichText = '<p>甲 &lt; 乙 &amp; 丙</p><p>第二段&nbsp;内容<br>续行</p>'
const draft = {
  kind: 'rich-text',
  fields: ['text', 'richText'],
  baseValues: { text: '原文', richText: true },
  draft: { text: rawRichText }
}
const originalDraftText = draft.draft.text
assert.strictEqual(
  format(draft.draft, ['text'], draft),
  '甲 < 乙 & 丙\n第二段 内容\n续行',
  'rich-text session should render paragraphs, breaks, and entities as readable text'
)
assert.strictEqual(draft.draft.text, originalDraftText, 'formatting must not mutate the raw draft')

assert.strictEqual(
  format({ text: '<p>2 < 5 and 8 > 6</p>', richText: false }, ['text']),
  '<p>2 < 5 and 8 > 6</p>',
  'explicit plain-text marker must preserve literal markup and comparison signs'
)
assert.strictEqual(
  format({ text: '2 < 5 and 8 > 6' }, ['text'], { kind: 'text' }),
  '2 < 5 and 8 > 6',
  'plain text without a rich-text marker must preserve comparison signs'
)
assert.strictEqual(
  format({ text: '<p>2 &lt; 5</p>' }, ['text'], { baseValues: { richText: true } }),
  '2 < 5',
  'historical baseline marker should identify rich-text draft content'
)
assert.strictEqual(
  format({ text: '<p>2 &lt; 5</p>' }, ['text'], { kind: 'rich-text', baseValues: { richText: false } }),
  '<p>2 &lt; 5</p>',
  'explicit normal-text baseline must override a legacy rich-text kind'
)

const unrelatedFields = { note: '<p>备注</p>', hyperlink: '<p>https://example.test</p>' }
assert.strictEqual(
  format(unrelatedFields, ['note', 'hyperlink'], { kind: 'rich-text' }),
  '<p>备注</p>\n\n链接:\n<p>https://example.test</p>',
  'notes and hyperlinks must not be treated as node rich text'
)

const copyText = component.computed.copyText.call({
  draft: { kind: 'rich-text', draft: { text: '<p>复制内容</p>' } },
  draftValues: { text: '<p>复制内容</p>' },
  fields: ['text'],
  formatValues(values, fields, source) {
    return component.methods.formatValues.call({ $t: t }, values, fields, source)
  }
})
assert.strictEqual(copyText, '复制内容', 'copy should use the same readable display formatter')

const latestText = format(
  { text: '<p>服务器 &amp; 最新</p>', richText: true },
  ['text'],
  { data: { richText: true } }
)
assert.strictEqual(latestText, '服务器 & 最新', 'latest server snapshot should use the display formatter')

console.log('PASS: conflict draft/latest display and copy format rich text safely without mutating source data or stripping unrelated fields.')
