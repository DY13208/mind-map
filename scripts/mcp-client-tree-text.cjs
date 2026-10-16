'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const RICH_TEXT_FILE = path.join(ROOT, 'simple-mind-map', 'src', 'plugins', 'RichText.js')
const UTILS_FILE = path.join(ROOT, 'simple-mind-map', 'src', 'utils', 'index.js')

function extractBetween(source, startMarker, endMarker, description) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`Cannot locate product ${description} start marker`)
  const bodyStart = start + startMarker.length
  const end = source.indexOf(endMarker, bodyStart)
  if (end < 0) throw new Error(`Cannot locate product ${description} end marker`)
  return source.slice(bodyStart, end)
}

function loadProductRichTextHandler() {
  const richTextSource = fs.readFileSync(RICH_TEXT_FILE, 'utf8').replace(/\r\n/g, '\n')
  const utilsSource = fs.readFileSync(UTILS_FILE, 'utf8').replace(/\r\n/g, '\n')
  const htmlEscapeBody = extractBetween(
    utilsSource,
    'export const htmlEscape = str => {',
    '\n}\n\n// 判断两个对象是否相同',
    'htmlEscape'
  )
  const htmlEscape = vm.runInNewContext(`(str => {${htmlEscapeBody}\n})`, Object.create(null), {
    filename: 'simple-mind-map/src/utils/index.js#htmlEscape'
  })
  const handlerBody = extractBetween(
    richTextSource,
    '  handleDataToRichText(data) {',
    '\n  }\n\n  // 处理导入数据',
    'RichText.handleDataToRichText'
  )
  // The browser-only DOM predicate is redundant for normal HTML tags because
  // the same product method immediately applies its explicit tag regex. A
  // false stub keeps this VM helper DOM-free while executing the real method.
  const checkIsRichText = () => false
  return vm.runInNewContext(`(data => {${handlerBody}\n})`, {
    htmlEscape,
    checkIsRichText
  }, { filename: 'simple-mind-map/src/plugins/RichText.js#handleDataToRichText' })
}

const handleDataToRichText = loadProductRichTextHandler()
const HTML_TAG_RE = /<\/?[a-z][\s\S]*>/i
const RENDER_HTML_TAG_RE = /<[a-z][\s\S]*?>/i

function expectedClientRenderText(nodeData) {
  const data = nodeData && typeof nodeData === 'object' ? nodeData : {}
  const rawText = String(data.text || '')
  const converted = { ...data, text: rawText }

  handleDataToRichText(converted)

  let expectedClientText = String(converted.text || '')
  let normalizationKind = 'product-html-passthrough'
  if (converted.resetRichText && !RENDER_HTML_TAG_RE.test(expectedClientText)) {
    // Exact counterpart of nodeCreateContents' resetRichText plain-text path.
    expectedClientText = `<p>${expectedClientText}</p>`
    normalizationKind = 'plain-to-rich-paragraph'
  } else if (converted.resetRichText) {
    normalizationKind = 'reset-richtext-html-preserved'
  } else if (HTML_TAG_RE.test(rawText)) {
    normalizationKind = 'html-passthrough-exact'
  }

  return {
    rawText,
    expectedClientText,
    normalizationApplied: rawText !== expectedClientText,
    normalizationKind
  }
}

function compareClientRenderText(nodeData, clientRenderText) {
  const expected = expectedClientRenderText(nodeData)
  const actualRenderText = String(clientRenderText || '')
  return {
    ...expected,
    actualRenderText,
    // Already-loaded nodes can retain the exact authoritative representation;
    // newly created rich-text nodes pass through the product conversion above.
    // Accept either exact representation, never stripped HTML or plain text.
    comparisonKind: expected.rawText === actualRenderText ? 'raw-exact' : 'product-render-exact',
    matches: expected.rawText === actualRenderText || expected.expectedClientText === actualRenderText
  }
}

module.exports = {
  expectedClientRenderText,
  compareClientRenderText
}
