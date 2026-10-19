'use strict'
// Scanned-document detection for the docling "auto" OCR fallback. Pure, no I/O.
// Input is DoclingDocument json_content from a first pass run with do_ocr=false.

// Formats docling rasterizes (PDF pages, images): the only ones OCR can help.
const OCR_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'])
const MAX_PAGE_NOS = 50

const nonSpaceLen = s => String(s == null ? '' : s).replace(/\s+/g, '').length

function provPages(item) {
  const out = []
  for (const p of (item && Array.isArray(item.prov) ? item.prov : [])) {
    if (p && Number.isInteger(p.page_no)) out.push(p.page_no)
  }
  return out
}

function tableChars(table) {
  const cells = table && table.data && Array.isArray(table.data.table_cells) ? table.data.table_cells : []
  return cells.reduce((n, c) => n + nonSpaceLen(c && c.text), 0)
}

// Counts only (never content): pages, extracted non-whitespace chars, pages with text / pictures,
// and pages without any text (docling emits no picture item for many full-page scans, so a
// textless page counts whether or not it has a picture).
function scanStats(doc) {
  doc = doc || {}
  const pages = new Set(Object.keys(doc.pages || {}).map(Number).filter(Number.isInteger))
  const textPages = new Set()
  const picturePages = new Set()
  let chars = 0
  const addText = (item, n) => {
    chars += n
    for (const p of provPages(item)) { pages.add(p); if (n > 0) textPages.add(p) }
  }
  for (const t of Array.isArray(doc.texts) ? doc.texts : []) addText(t, nonSpaceLen(t && t.text))
  for (const t of Array.isArray(doc.tables) ? doc.tables : []) addText(t, tableChars(t))
  for (const p of Array.isArray(doc.pictures) ? doc.pictures : []) {
    for (const n of provPages(p)) { pages.add(n); picturePages.add(n) }
  }
  let textlessPicturePages = 0
  for (const p of picturePages) if (!textPages.has(p)) textlessPicturePages++
  const textless = [...pages].filter(p => !textPages.has(p)).sort((a, b) => a - b)
  return {
    pages: pages.size, chars, textPages: textPages.size, picturePages: picturePages.size, textlessPicturePages,
    textlessPages: textless.length, textlessPageNos: textless.slice(0, MAX_PAGE_NOS)
  }
}

// true when the first pass looks like a scan: almost no text per page, or most pages are
// pictures without any text. A document with no pages and no text also counts (nothing to lose).
function looksScanned(stats, { minCharsPerPage = 20, textlessPageRatio = 0.6 } = {}) {
  if (!stats) return false
  if (!stats.pages) return stats.chars === 0
  if (stats.chars / stats.pages < minCharsPerPage) return true
  return stats.textlessPicturePages / stats.pages >= textlessPageRatio
}

// 'full'  -> (mostly) scanned document: OCR every page (force_ocr allowed).
// 'mixed' -> text document with at least mixedMinPages pages that have no text at all:
//            OCR only bitmap regions (force_ocr=false keeps the programmatic text).
// null    -> plain text document, keep the first pass. mixedMinPages=0 disables 'mixed'.
function scanKind(stats, { minCharsPerPage = 20, textlessPageRatio = 0.6, mixedMinPages = 1 } = {}) {
  if (!stats) return null
  if (looksScanned(stats, { minCharsPerPage, textlessPageRatio })) return 'full'
  const textless = Number.isInteger(stats.textlessPages) ? stats.textlessPages : 0
  if (mixedMinPages > 0 && stats.textPages > 0 && textless >= mixedMinPages) return 'mixed'
  return null
}

module.exports = { OCR_EXTS, scanStats, looksScanned, scanKind }
