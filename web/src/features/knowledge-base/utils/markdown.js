import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: false, breaks: false })
const normalize = text => String(text || '').replace(/\s+/g, ' ').trim()
const textOf = token => token.children
  ? token.children.map(t => t.type === 'softbreak' || t.type === 'hardbreak' ? ' ' : t.content || '').join('')
  : token.content

// Source maps come from Markdown tokens, never guessed page coordinates.
export function markdownDocument(source) {
  const text = String(source || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const tokens = md.parse(text, {})
  const ranges = []
  tokens.forEach(token => {
    if (!token.map) return
    const [start, end] = token.map
    if (token.type === 'inline' || token.type === 'fence' || token.type === 'code_block') {
      ranges.push({ lineStart: start + 1, lineEnd: end, text: normalize(textOf(token)) })
    }
    if (token.type !== 'inline') {
      token.attrSet('data-source-start', String(start + 1))
      token.attrSet('data-source-end', String(end))
    }
  })
  return { text, html: md.renderer.render(tokens, md.options, {}), ranges }
}

export function locateMarkdownBlocks(blocks, document) {
  if (!document) return blocks
  return blocks.map(block => {
    const text = normalize(block.text || block.content || block.markdown)
    if (!text) return block
    const candidates = document.ranges.filter(range => range.text === text)
    // Duplicate passages are ambiguous: retain the warning instead of inventing a position.
    let range = candidates.length === 1 ? candidates[0] : null
    if (!range && !candidates.length) {
      const index = document.text.indexOf(String(block.text || block.content || block.markdown).trim())
      const raw = String(block.text || block.content || block.markdown).trim()
      if (index >= 0 && document.text.indexOf(raw, index + 1) < 0) {
        const lineStart = document.text.slice(0, index).split('\n').length
        range = { lineStart, lineEnd: lineStart + raw.split('\n').length - 1 }
      }
    }
    return range ? { ...block, lineStart: range.lineStart, lineEnd: range.lineEnd } : block
  })
}
