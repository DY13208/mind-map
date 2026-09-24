/* global require */

const assert = require('assert')
const {
  trimNodeEditText,
  trimRichTextHtml
} = require('../src/utils/trimNodeEditText')

assert.strictEqual(trimNodeEditText('  hello  \n'), 'hello')
assert.strictEqual(trimNodeEditText('\n\n你好\n\n'), '你好')
assert.strictEqual(trimNodeEditText('\u00a0text\u00a0'), 'text')
assert.strictEqual(trimNodeEditText(null), '')
assert.strictEqual(trimNodeEditText(''), '')

assert.strictEqual(
  trimRichTextHtml('<p>hello</p><p><br></p><p><br></p>'),
  '<p>hello</p>'
)
assert.strictEqual(
  trimRichTextHtml('<p><br></p><p>hello</p>'),
  '<p>hello</p>'
)
assert.strictEqual(
  trimRichTextHtml('<p>&nbsp;</p><p>中间</p><p><br/></p>'),
  '<p>中间</p>'
)
assert.strictEqual(
  trimNodeEditText('<p>  徐健：希望右键拖动  </p><p><br></p>', true),
  '<p>徐健：希望右键拖动</p>'
)
assert.strictEqual(trimRichTextHtml('<p><br></p><p><br></p>'), '')

console.log('trimNodeEditText.test.js ok')
