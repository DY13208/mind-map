/* global module require */
// Coloured per-file-type attachment icons (48x48 viewBox).
// - Canvas variant (default): no text, legible at ~20px.
// - Labelled variant ({ label: true }): includes the type label, for larger UI.
const { getAttachmentFileIconType } = require('../utils/attachmentFileType')

const PAGE = 'M10 3h20l10 10v30a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'
const FOLD = '<path d="M30 3v8a2 2 0 0 0 2 2h8z" fill="#fff" fill-opacity=".45"/>'
const FONT = 'font-family="Arial,Helvetica,sans-serif" font-weight="700"'
// Simple white bars used on the canvas for document-like types.
const LINES = '<path d="M14 21h20v4H14zM14 28h20v4H14zM14 35h13v4H14z" fill="#fff"/>'

const glyphs = {
  image: { canvas: '<circle cx="30" cy="20" r="4" fill="#fff"/><path d="M12 38l9-12 7 8 4-4 6 8z" fill="#fff"/>', label: '<circle cx="29" cy="20" r="3" fill="#fff"/><path d="M14 28l6-8 5 6 3-3 5 5z" fill="#fff"/>' },
  archive: { canvas: '<path d="M19 5h4v4h-4zM23 9h4v4h-4zM19 13h4v4h-4zM23 17h4v4h-4z" fill="#fff" fill-opacity=".75"/><rect x="18" y="24" width="10" height="13" rx="2" fill="#fff"/>', label: '<path d="M20 5h3v3h-3zM23 8h3v3h-3zM20 11h3v3h-3zM23 14h3v3h-3z" fill="#fff" fill-opacity=".6"/>' },
  code: { canvas: '<path d="M20 18c-3 0-3 2-3 4v2c0 2-1 3-3 3 2 0 3 1 3 3v2c0 2 0 4 3 4M28 18c3 0 3 2 3 4v2c0 2 1 3 3 3-2 0-3 1-3 3v2c0 2 0 4-3 4" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>', label: '<text x="24" y="25" text-anchor="middle" font-family="DejaVu Sans Mono,monospace" font-weight="700" font-size="12" fill="#fff">{}</text>' },
  audio: { canvas: '<path d="M27 15v15a5 5 0 1 1-3-4.6V15h10v5h-7z" fill="#fff"/>', label: '<path d="M26 12v11.5a3.5 3.5 0 1 1-2-3.2V12h7v4h-5z" fill="#fff"/>' },
  video: { canvas: '<path d="M18 19v18l15-9z" fill="#fff"/>', label: '<path d="M20 14v12l10-6z" fill="#fff"/>' }
}

const types = {
  pdf: { color: '#E5484D', label: 'PDF' },
  word: { color: '#2B6CE6', label: 'DOC' },
  spreadsheet: { color: '#1F9D55', label: 'XLS' },
  presentation: { color: '#E8710A', label: 'PPT' },
  image: { color: '#8E4EC6', label: 'IMG' },
  archive: { color: '#D9A400', label: 'ZIP' },
  text: { color: '#6B7280', label: 'TXT' },
  markdown: { color: '#374151', label: 'MD' },
  html: { color: '#E34C26', label: 'HTML' },
  code: { color: '#0F766E', label: 'JSON', useExt: true },
  audio: { color: '#DB2777', label: 'MP3', useExt: true },
  video: { color: '#7C3AED', label: 'MP4', useExt: true }
}

const wrap = body =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">' + body + '</svg>'
const labelText = text =>
  `<text x="24" y="40" text-anchor="middle" ${FONT} font-size="${text.length > 3 ? 9.5 : 12}" fill="#fff">${text}</text>`

function buildIcon(type, { label = false, text } = {}) {
  const def = types[type]
  const g = glyphs[type]
  let body = `<path d="${PAGE}" fill="${def.color}"/>` + FOLD
  if (label) body += (g ? g.label : '') + labelText(text || def.label)
  else body += g ? g.canvas : LINES
  return wrap(body)
}

const genericIcon = ({ label = false } = {}) =>
  wrap(
    `<path d="${PAGE}" fill="#fff" stroke="#9CA3AF" stroke-width="2.5" stroke-linejoin="round"/>` +
      '<path d="M30 3v8a2 2 0 0 0 2 2h8" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="2.5" stroke-linejoin="round"/>' +
      (label
        ? '<path d="M20 26v-9a3 3 0 0 1 6 0v10a5 5 0 0 1-10 0v-8" fill="none" stroke="#9CA3AF" stroke-width="2" stroke-linecap="round"/>' +
          `<text x="24" y="40" text-anchor="middle" ${FONT} font-size="9.5" fill="#4B5563">FILE</text>`
        : '<path d="M21 33V19a4 4 0 0 1 8 0v15a7 7 0 0 1-14 0V22" fill="none" stroke="#6B7280" stroke-width="3" stroke-linecap="round"/>')
  )

const attachmentFileIcons = {}
const attachmentFileIconsLabeled = {}
Object.keys(types).forEach(type => {
  attachmentFileIcons[type] = buildIcon(type)
  attachmentFileIconsLabeled[type] = buildIcon(type, { label: true })
})
attachmentFileIcons.json = attachmentFileIcons.code
attachmentFileIconsLabeled.json = attachmentFileIconsLabeled.code
attachmentFileIcons.generic = genericIcon()
attachmentFileIconsLabeled.generic = genericIcon({ label: true })

const extOf = name => {
  const m = /\.([a-z0-9]{1,4})$/i.exec(String(name || '').trim())
  return m ? m[1].toUpperCase() : ''
}

// Returns the SVG string for a file, or `fallback` (e.g. paperclip) when there
// is neither a name nor a mime type. Unknown real files get the grey generic icon.
function getAttachmentFileIconSvg(fileName, mimeType = '', options = {}) {
  const { label = false, fallback = '' } = options || {}
  const type = getAttachmentFileIconType(fileName, mimeType)
  if (types[type]) {
    if (!label) return attachmentFileIcons[type]
    const ext = types[type].useExt ? extOf(fileName) : ''
    return ext ? buildIcon(type, { label: true, text: ext }) : attachmentFileIconsLabeled[type]
  }
  const hasInfo = String(fileName || '').trim() || String(mimeType || '').trim()
  if (!hasInfo && fallback) return fallback
  return label ? attachmentFileIconsLabeled.generic : attachmentFileIcons.generic
}

module.exports = {
  attachmentFileIcons,
  attachmentFileIconsLabeled,
  getAttachmentFileIconSvg
}
