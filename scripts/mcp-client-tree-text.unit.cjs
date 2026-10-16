'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { compareClientRenderText, expectedClientRenderText } = require('./mcp-client-tree-text.cjs')

let assertions = 0
function check(condition, message) {
  assert(condition, message)
  assertions += 1
}

const plain = compareClientRenderText({ text: 'plain text' }, '<p>plain text</p>')
check(plain.matches, 'plain DB text should match the exact product paragraph wrapper')
check(plain.rawText === 'plain text' && plain.expectedClientText === '<p>plain text</p>',
  'plain comparison should report both raw and rendered boundary values')
check(plain.normalizationApplied && plain.normalizationKind === 'plain-to-rich-paragraph',
  'plain comparison should identify the paragraph normalization')
check(compareClientRenderText({ text: 'plain text' }, 'plain text').matches,
  'already-loaded nodes retaining exact authoritative text must also match')

const escaped = expectedClientRenderText({ text: 'A < B & C > D' })
check(escaped.expectedClientText === '<p>A &lt; B &amp; C &gt; D</p>',
  'plain text must use the product htmlEscape output before paragraph wrapping')
check(compareClientRenderText({ text: 'A < B & C > D' }, '<p>A < B & C > D</p>').matches === false,
  'unescaped markup-sensitive text must not be accepted')

const literalHtml = compareClientRenderText({ text: '<strong>literal HTML</strong>' }, '<strong>literal HTML</strong>')
check(literalHtml.matches && literalHtml.normalizationKind === 'html-passthrough-exact',
  'tag-shaped source text follows the product HTML passthrough contract exactly')
check(compareClientRenderText({ text: '<strong>literal HTML</strong>' }, '<p>literal HTML</p>').matches === false,
  'HTML tags must never be stripped to create a match')

const formatted = '<p><strong>formatted</strong></p>'
check(compareClientRenderText({ text: formatted, richText: true }, formatted).matches,
  'existing rich text should remain an exact comparison')
check(!compareClientRenderText({ text: formatted, richText: true }, '<p><em>formatted</em></p>').matches,
  'rich-text formatting differences must remain detectable')

check(compareClientRenderText({ text: 'line one\nline two' }, '<p>line one\nline two</p>').matches,
  'line breaks must remain intact inside the product paragraph wrapper')
check(compareClientRenderText({ text: '' }, '<p></p>').matches,
  'empty plain text follows the renderer paragraph wrapping behavior')

let savedArtifactCheck = null
if (process.argv[2]) {
  const file = path.resolve(process.argv[2])
  const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
  const clients = summary.clientTreeConvergence && summary.clientTreeConvergence.clients || []
  const priorTextMismatches = clients.flatMap(client => client.loadedModelMismatches || [])
    .filter(row => row.reason === 'text')
  for (const row of priorTextMismatches) {
    check(compareClientRenderText({ text: row.expected }, row.actual).matches,
      `saved text mismatch should be recognized as exact product normalization for ${row.uid}`)
  }
  savedArtifactCheck = {
    path: path.relative(process.cwd(), file),
    priorTextMismatchCount: priorTextMismatches.length,
    normalizedEqualCount: priorTextMismatches.length
  }
}

console.log(JSON.stringify({ status: 'pass', assertions, savedArtifactCheck }))
