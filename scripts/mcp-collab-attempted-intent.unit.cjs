const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { compareClientRenderText } = require('./mcp-client-tree-text.cjs')

const source = fs.readFileSync(path.join(__dirname, 'mcp-collab-performance.cjs'), 'utf8').replace(/\r\n/g, '\n')
const start = source.indexOf('function classifyAttemptedTextIntents(')
const end = source.indexOf('\n\nfunction operationCorrectness', start)
assert(start >= 0 && end > start, 'attempted-intent classifier should be present')
const classify = vm.runInNewContext(`(${source.slice(start, end)})`, { compareClientRenderText })

const result = classify(
  new Map([
    ['plain-normalized', 'same'],
    ['exact', 'unchanged'],
    ['real-difference', 'wanted'],
    ['unsafe-markup', '<img src=x onerror=alert(1)>']
  ]),
  new Map([
    ['plain-normalized', { text: '<p>same</p>', version: 18 }],
    ['exact', { text: 'unchanged', version: 19 }],
    ['real-difference', { text: '<p>other</p>', version: 20 }],
    ['unsafe-markup', { text: '<p>[removed]</p>', version: 21 }]
  ])
)

assert.deepEqual(Array.from(result.matchedUids), ['plain-normalized', 'exact'],
  'plain rich-text wrapper and exact storage should match without forgiving actual text differences')
assert.deepEqual(Array.from(result.plainRichTextNormalizedMatchUids), ['plain-normalized'])
assert.equal(result.plainRichTextNormalizedMatchCount, 1,
  'report the controlled plain-to-rich paragraph representation count separately')
assert.deepEqual(Array.from(result.notCommitted, row => row.uid), ['real-difference', 'unsafe-markup'])
assert.equal(result.notCommitted[0].reason, 'latest_committed_text_differs')
assert.equal(result.notCommitted[1].reason, 'latest_committed_text_differs',
  'HTML-like attempted input must not match by stripping or sanitizing markup')
console.log('PASS: attempted-intent auditing reuses the product text comparator, reports plain-to-rich normalization, and preserves real/HTML differences.')
