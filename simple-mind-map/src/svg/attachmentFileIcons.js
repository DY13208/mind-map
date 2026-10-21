/* global module require */
// Per-file-type attachment icons (48x48 viewBox).
// - Canvas variant (default): solid coloured page, no text, legible at ~20px.
// - Labelled variant ({ label: true }): white paper card with a content sketch
//   and a coloured extension tag, for UI rendered at 36px and above. Its paper,
//   ring and ink colours read the CSS variables --afc-paper / --afc-ring /
//   --afc-ink so the host page can theme it (e.g. dark mode).
const { getAttachmentFileIconType } = require('../utils/attachmentFileType')

const PAGE = 'M10 3h20l10 10v30a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'
const FOLD = '<path d="M30 3v8a2 2 0 0 0 2 2h8z" fill="#fff" fill-opacity=".45"/>'
// Simple white bars used on the canvas for document-like types.
const LINES = '<path d="M14 21h20v4H14zM14 28h20v4H14zM14 35h13v4H14z" fill="#fff"/>'

const glyphs = {
  image: '<circle cx="30" cy="20" r="4" fill="#fff"/><path d="M12 38l9-12 7 8 4-4 6 8z" fill="#fff"/>',
  archive: '<path d="M19 5h4v4h-4zM23 9h4v4h-4zM19 13h4v4h-4zM23 17h4v4h-4z" fill="#fff" fill-opacity=".75"/><rect x="18" y="24" width="10" height="13" rx="2" fill="#fff"/>',
  code: '<path d="M20 18c-3 0-3 2-3 4v2c0 2-1 3-3 3 2 0 3 1 3 3v2c0 2 0 4 3 4M28 18c3 0 3 2 3 4v2c0 2 1 3 3 3-2 0-3 1-3 3v2c0 2 0 4-3 4" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
  audio: '<path d="M27 15v15a5 5 0 1 1-3-4.6V15h10v5h-7z" fill="#fff"/>',
  video: '<path d="M18 19v18l15-9z" fill="#fff"/>'
}

// `color` is the canvas page colour, `tag` the labelled-card tag colour.
const types = {
  pdf: { color: '#E5484D', tag: '#EF4444', label: 'PDF' },
  word: { color: '#2B6CE6', tag: '#3B82F6', label: 'DOC' },
  spreadsheet: { color: '#1F9D55', tag: '#059669', label: 'XLS' },
  presentation: { color: '#E8710A', tag: '#F97316', label: 'PPT' },
  image: { color: '#8E4EC6', tag: '#EC4899', label: 'IMG' },
  archive: { color: '#D9A400', tag: '#A855F7', label: 'ZIP' },
  text: { color: '#6B7280', tag: '#6B7280', label: 'TXT' },
  markdown: { color: '#374151', tag: '#525252', label: 'MD' },
  html: { color: '#E34C26', tag: '#EA580C', label: 'HTML' },
  code: { color: '#0F766E', tag: '#2563EB', label: 'CODE' },
  audio: { color: '#DB2777', tag: '#E11D48', label: 'MP3' },
  video: { color: '#7C3AED', tag: '#15803D', label: 'MP4' }
}
const TAG_BY_EXT = { CSV: '#0F766E', JSON: '#CA8A04', JS: '#CA8A04' }

const wrap = body =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">' + body + '</svg>'

function buildIcon(type) {
  const def = types[type]
  return wrap(`<path d="${PAGE}" fill="${def.color}"/>` + FOLD + (glyphs[type] || LINES))
}

const genericIcon = () =>
  wrap(
    `<path d="${PAGE}" fill="#fff" stroke="#9CA3AF" stroke-width="2.5" stroke-linejoin="round"/>` +
      '<path d="M30 3v8a2 2 0 0 0 2 2h8" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="2.5" stroke-linejoin="round"/>' +
      '<path d="M21 33V19a4 4 0 0 1 8 0v15a7 7 0 0 1-14 0V22" fill="none" stroke="#6B7280" stroke-width="3" stroke-linecap="round"/>'
  )

// ---- Labelled card ----
const INK = 'style="fill:var(--afc-ink,#0F172A)"'
const MONO = 'font-family="ui-monospace,Consolas,monospace" font-weight="700"'
const SANS = `font-family="ui-sans-serif,-apple-system,'Segoe UI',Arial,sans-serif" font-weight="600"`
const X = 10.5
const SKY = '#38BDF8'
const EMERALD = '#34D399'

const bar = (x, y, w, o) =>
  `<rect x="${x}" y="${y}" width="${w}" height="1.6" rx=".8" ${INK} fill-opacity="${o}"/>`
const tint = (x, y, w, color, o = 0.7) =>
  `<rect x="${x}" y="${y}" width="${w}" height="1.6" rx=".8" fill="${color}" fill-opacity="${o}"/>`
const glyph = (x, y, text, size, o) =>
  `<text x="${x}" y="${y}" ${MONO} font-size="${size}" ${INK} fill-opacity="${o}">${text}</text>`
const frame = h =>
  `<rect x="${X}" y="7" width="22" height="${h}" rx="1.5" style="fill:var(--afc-ink,#0F172A);stroke:var(--afc-ring,#E2E8F0)" fill-opacity=".05" stroke-width=".6"/>`
const caption = y => bar(18.5, y, 6, 0.15) + bar(15.5, y + 3.5, 12, 0.15)

const docSketch =
  bar(X, 8, 11, 0.22) +
  bar(X, 12.5, 7, 0.1) + bar(X + 8.5, 12.5, 7, 0.1) +
  bar(X, 17, 11, 0.1) + bar(X + 12.5, 17, 7, 0.1) +
  bar(X, 21.5, 7, 0.1) + bar(X + 8.5, 21.5, 7, 0.1) +
  bar(X, 26, 7, 0.1) + bar(X + 8.5, 26, 11, 0.1)

const sheetSketch = (() => {
  const cell = (col, y, o) =>
    `<rect x="${X + col * 7.7}" y="${y}" width="6.6" height="3.2" rx=".4" ${INK} fill-opacity="${o}"/>`
  const row = (y, count, o) => [0, 1, 2].slice(0, count).map(col => cell(col, y, o)).join('')
  return row(7, 3, 0.22) + row(11.3, 3, 0.08) + row(15.6, 3, 0.08) + row(19.9, 2, 0.08) + row(24.2, 1, 0.08)
})()

const archiveSketch = Array.from({ length: 9 }, (_, i) => {
  const y = 7 + i * 2.6
  const [left, right] = i % 2 ? [0.07, 0.24] : [0.24, 0.07]
  return (
    `<rect x="18.9" y="${y}" width="2.6" height="2.6" ${INK} fill-opacity="${left}"/>` +
    `<rect x="21.5" y="${y}" width="2.6" height="2.6" ${INK} fill-opacity="${right}"/>`
  )
}).join('')

const tagRow = (y, indent, w, color, open, close) => {
  const x = X + indent
  const barX = x + open.length * 2.8 + 0.6
  return (
    glyph(x, y + 1.7, open.replace('<', '&lt;'), 4.6, 0.35) +
    tint(barX, y, w, color) +
    glyph(barX + w + 0.6, y + 1.7, close.replace('>', '&gt;'), 4.6, 0.35)
  )
}

const sketches = {
  markdown:
    glyph(X, 11.2, '#', 6, 0.32) + bar(X + 5, 8.4, 10, 0.22) +
    bar(X, 14, 8, 0.1) + bar(X, 17.5, 13, 0.1) +
    bar(X, 22, 14, 0.1) + bar(X, 25.5, 7, 0.1) + bar(X, 29, 9, 0.1),
  spreadsheet: sheetSketch,
  archive: archiveSketch,
  presentation:
    frame(12) +
    '<rect x="19" y="9.2" width="5" height="5" rx=".8" fill="#FB923C" fill-opacity=".55"/>' +
    bar(15.5, 16.2, 12, 0.15) +
    bar(13, 22.5, 11, 0.15) + bar(25, 22.5, 5.5, 0.15) +
    bar(X, 26.5, 6, 0.15) + bar(X, 30, 8, 0.15),
  image:
    frame(14) +
    '<circle cx="27.6" cy="10.8" r="1.8" fill="#FACC15"/>' +
    `<path d="M12 19.6l5.2-6.2 3.6 4.1 2.6-2.8 7.6 4.9z" ${INK} fill-opacity=".18"/>` +
    caption(24),
  video: frame(14) + '<path d="M19.5 10.5v7l6-3.5z" fill="#22C55E" fill-opacity=".8"/>' + caption(24),
  audio:
    frame(14) +
    [3, 6, 9, 5, 8, 4, 7, 3]
      .map((h, i) => `<rect x="${12.4 + i * 2.4}" y="${14 - h / 2}" width="1.4" height="${h}" rx=".7" fill="#F472B6" fill-opacity=".75"/>`)
      .join('') +
    caption(24),
  html:
    tagRow(8, 0, 7, EMERALD, '<', '>') +
    tagRow(12.5, 2.5, 6, SKY, '<', '>') +
    tagRow(17, 2.5, 6, SKY, '</', '>') +
    tagRow(21.5, 0, 3, EMERALD, '<', '/>') +
    bar(X + 2.5, 26, 9, 0.1),
  code:
    glyph(X, 10.5, '{', 6, 0.4) +
    bar(X + 2.8, 13, 5, 0.22) + tint(X + 8.8, 13, 7, SKY, 0.65) +
    bar(X + 2.8, 17, 7, 0.22) + tint(X + 10.8, 17, 4, SKY, 0.65) +
    bar(X + 2.8, 21, 5, 0.22) + tint(X + 8.8, 21, 7, SKY, 0.65) +
    bar(X + 2.8, 25, 4, 0.22) +
    glyph(X, 30.5, '}', 6, 0.4)
}

function buildCardIcon(type, ext = '') {
  const def = types[type]
  const text = ext || (def ? def.label : 'FILE')
  const color = TAG_BY_EXT[text] || (def ? def.tag : '#64748B')
  const size = text.length > 3 ? 6.4 : 7
  const width = 5.5 + text.length * (size > 6.5 ? 4.7 : 4.3)
  const right = 42.5
  return wrap(
    '<rect x="6" y="2.5" width="31" height="40" rx="3" style="fill:var(--afc-paper,#fff);stroke:var(--afc-ring,#E2E8F0)" stroke-width="1"/>' +
      (sketches[type] || docSketch) +
      `<rect x="${right - width}" y="30" width="${width}" height="9" rx="1.6" fill="${color}"/>` +
      `<text x="${right - width / 2}" y="37" text-anchor="middle" ${SANS} font-size="${size}" letter-spacing=".2" fill="#fff">${text}</text>`
  )
}

const attachmentFileIcons = {}
const attachmentFileIconsLabeled = {}
Object.keys(types).forEach(type => {
  attachmentFileIcons[type] = buildIcon(type)
  attachmentFileIconsLabeled[type] = buildCardIcon(type)
})
attachmentFileIcons.json = attachmentFileIcons.code
attachmentFileIconsLabeled.json = buildCardIcon('code', 'JSON')
attachmentFileIcons.generic = genericIcon()
attachmentFileIconsLabeled.generic = buildCardIcon('generic')

const extOf = name => {
  const m = /\.([a-z0-9]{1,4})$/i.exec(String(name || '').trim())
  return m ? m[1].toUpperCase() : ''
}

// Returns the SVG string for a file, or `fallback` (e.g. paperclip) when there
// is neither a name nor a mime type. Unknown real files get the generic icon.
function getAttachmentFileIconSvg(fileName, mimeType = '', options = {}) {
  const { label = false, fallback = '' } = options || {}
  const type = getAttachmentFileIconType(fileName, mimeType)
  if (types[type]) {
    return label ? buildCardIcon(type, extOf(fileName)) : attachmentFileIcons[type]
  }
  const hasInfo = String(fileName || '').trim() || String(mimeType || '').trim()
  if (!hasInfo && fallback) return fallback
  return label ? buildCardIcon('generic', extOf(fileName)) : attachmentFileIcons.generic
}

module.exports = {
  attachmentFileIcons,
  attachmentFileIconsLabeled,
  getAttachmentFileIconSvg
}
