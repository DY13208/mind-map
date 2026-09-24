/* global module */

// 首尾空白（含普通空白、换行、不间断空格）
const NODE_EDIT_EDGE_WS = /[\s\u00a0\u2007\u202f]+/
const RICH_EMPTY_BLOCK_START =
  /^(?:\s*<(?:p|div)(?:\s[^>]*)?>\s*(?:<br\s*\/?\s*>|&nbsp;|\u00a0|\s)*<\/(?:p|div)>\s*)+/i
const RICH_EMPTY_BLOCK_END =
  /(?:\s*<(?:p|div)(?:\s[^>]*)?>\s*(?:<br\s*\/?\s*>|&nbsp;|\u00a0|\s)*<\/(?:p|div)>\s*)+$/i

function isVisuallyEmptyHtmlNode(node) {
  if (!node) return true
  if (node.nodeType === 3) {
    return !String(node.textContent || '').replace(NODE_EDIT_EDGE_WS, '')
  }
  if (node.nodeType !== 1) return true
  const text = String(node.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\u2007/g, ' ')
    .replace(/\u202f/g, ' ')
    .trim()
  return text === ''
}

function trimTextNodeEdge(node, edge) {
  if (!node || node.nodeType !== 3) return
  const value = String(node.textContent || '')
  node.textContent =
    edge === 'start'
      ? value.replace(/^[\s\u00a0\u2007\u202f]+/, '')
      : value.replace(/[\s\u00a0\u2007\u202f]+$/, '')
}

function trimRichHtmlEdgeInside(root, edge) {
  if (!root || root.nodeType !== 1) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  if (edge === 'start') {
    let current = walker.nextNode()
    while (current) {
      trimTextNodeEdge(current, 'start')
      if (current.textContent) return
      const empty = current
      current = walker.nextNode()
      if (empty.parentNode) empty.parentNode.removeChild(empty)
    }
    return
  }
  let last = null
  let current = walker.nextNode()
  while (current) {
    last = current
    current = walker.nextNode()
  }
  if (last) trimTextNodeEdge(last, 'end')
}

function trimRichTextHtmlWithRegex(html) {
  let value = String(html == null ? '' : html)
  let prev = ''
  while (value !== prev) {
    prev = value
    value = value
      .replace(RICH_EMPTY_BLOCK_START, '')
      .replace(RICH_EMPTY_BLOCK_END, '')
  }
  // 去掉首尾段落内的空格 / &nbsp;
  value = value.replace(
    /^(<[a-zA-Z][^>]*>)(?:&nbsp;|\u00a0|[\s\u2007\u202f])+/,
    '$1'
  )
  value = value.replace(
    /(?:&nbsp;|\u00a0|[\s\u2007\u202f])+(<\/[a-zA-Z]+>)\s*$/,
    '$1'
  )
  return value.replace(/^[\s\u00a0\u2007\u202f]+|[\s\u00a0\u2007\u202f]+$/g, '')
}

function trimRichTextHtml(html) {
  const raw = String(html == null ? '' : html)
  if (!raw) return ''

  // 无 DOM 环境（单测）：正则去掉首尾空段落与边缘空白
  if (typeof document === 'undefined' || !document.createElement) {
    return trimRichTextHtmlWithRegex(raw)
  }

  const root = document.createElement('div')
  root.innerHTML = raw

  while (root.firstChild && isVisuallyEmptyHtmlNode(root.firstChild)) {
    root.removeChild(root.firstChild)
  }
  while (root.lastChild && isVisuallyEmptyHtmlNode(root.lastChild)) {
    root.removeChild(root.lastChild)
  }

  if (root.firstChild) trimRichHtmlEdgeInside(root.firstChild, 'start')
  if (root.lastChild) trimRichHtmlEdgeInside(root.lastChild, 'end')

  // 边缘 trim 后可能再次露出空段落
  while (root.firstChild && isVisuallyEmptyHtmlNode(root.firstChild)) {
    root.removeChild(root.firstChild)
  }
  while (root.lastChild && isVisuallyEmptyHtmlNode(root.lastChild)) {
    root.removeChild(root.lastChild)
  }

  return root.innerHTML
}

// 节点编辑确认时去掉首尾空格/换行（普通文本与富文本 HTML）
function trimNodeEditText(text, richText) {
  if (text == null) return ''
  const raw = String(text)
  if (!richText) {
    return raw.replace(/^[\s\u00a0\u2007\u202f]+|[\s\u00a0\u2007\u202f]+$/g, '')
  }
  return trimRichTextHtml(raw)
}

module.exports = {
  trimNodeEditText,
  trimRichTextHtml
}
