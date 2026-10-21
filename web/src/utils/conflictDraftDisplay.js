const BLOCK_TAGS =
  'address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul'

const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  bull: '•',
  cent: '¢',
  copy: '©',
  deg: '°',
  divide: '÷',
  euro: '€',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  pound: '£',
  quot: '"',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  trade: '™',
  times: '×',
  yen: '¥',
  gt: '>',
  lt: '<'
}

function decodeEntity(entity) {
  const body = entity.slice(1, -1)
  if (body[0] === '#') {
    const isHex = body[1] === 'x' || body[1] === 'X'
    const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      return entity
    }
    try {
      return String.fromCodePoint(codePoint)
    } catch (_) {
      return entity
    }
  }
  const name = body.toLowerCase()
  return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
    ? NAMED_ENTITIES[name]
    : entity
}

function richTextToPlainText(value) {
  return String(value == null ? '' : value)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    // Quill's inline tags and other well-formed HTML tags are markup here. A
    // comparison such as "2 < 5" does not match this tag-shaped expression.
    .replace(/<\/?[a-z][a-z0-9:-]*(?:\s[^<>]*?)?\s*\/?>/gi, '')
    .replace(/&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/g, decodeEntity)
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]*\n[\t ]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Display-only conversion for a node's text field; source values stay intact. */
export function formatConflictText(value, isRichText) {
  if (typeof value !== 'string' || !isRichText) return value
  return richTextToPlainText(value)
}

/** Resolve rich-text status across current and historical session shapes. */
export function isConflictRichText(values, session) {
  if (values && typeof values.richText === 'boolean') return values.richText
  const baseValues = session && session.baseValues
  if (baseValues && typeof baseValues.richText === 'boolean') {
    return baseValues.richText
  }
  return !!(session && session.kind === 'rich-text')
}
