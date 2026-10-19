'use strict'
// DoclingDocument JSON -> ordered blocks (reading order from body tree).
const TYPE_MAP = {
  title: 'title', section_header: 'heading', text: 'paragraph', paragraph: 'paragraph', list_item: 'list_item',
  caption: 'caption', footnote: 'footnote', page_header: 'page_header', page_footer: 'page_footer',
  code: 'code', formula: 'formula', table: 'table', picture: 'picture', chart: 'picture', document_index: 'table',
  checkbox_selected: 'list_item', checkbox_unselected: 'list_item', reference: 'paragraph', key_value_region: 'paragraph'
}

function resolve(doc, ref) {
  const m = /^#\/(\w+)\/(\d+)$/.exec(ref || '')
  if (!m) return null
  const arr = doc[m[1]]
  return Array.isArray(arr) ? { kind: m[1], item: arr[Number(m[2])] } : null
}

function tableText(table) {
  const data = table.data || {}
  const grid = Array.isArray(data.grid) ? data.grid : null
  if (grid && grid.length) {
    return grid.map(row => row.map(c => String((c && c.text) || '').replace(/\s+/g, ' ').trim()).join(' | ')).join('\n')
  }
  const cells = Array.isArray(data.table_cells) ? data.table_cells : []
  const rows = []
  for (const c of cells) {
    const r = c.start_row_offset_idx || 0
    const col = c.start_col_offset_idx || 0
    ;(rows[r] = rows[r] || [])[col] = String(c.text || '').trim()
  }
  return rows.map(r => (r || []).join(' | ')).join('\n')
}

function tableGrid(table) {
  const grid = table.data && Array.isArray(table.data.grid) ? table.data.grid : []
  return grid.map(row => row.map(c => String((c && c.text) || '').trim()))
}

const clamp01 = v => Math.min(1, Math.max(0, Math.round(v * 10000) / 10000))

// bbox keeps docling's raw coords and adds norm=[x0,y0,x1,y1] in 0..1, top-left origin
// (what the frontend highlights with; see CONTRACT.md).
function provOf(item, pages) {
  const p = Array.isArray(item.prov) && item.prov[0]
  if (!p) return { page: null, bbox: null }
  const page = Number.isInteger(p.page_no) ? p.page_no : null
  let b = null
  if (p.bbox) {
    b = { l: p.bbox.l, t: p.bbox.t, r: p.bbox.r, b: p.bbox.b, origin: p.bbox.coord_origin || null }
    const size = page != null && pages && pages[String(page)] && pages[String(page)].size
    if (size && size.width > 0 && size.height > 0) {
      const W = size.width, H = size.height
      const bottomLeft = String(b.origin || '').toUpperCase() === 'BOTTOMLEFT'
      const y0 = bottomLeft ? (H - b.t) / H : b.t / H
      const y1 = bottomLeft ? (H - b.b) / H : b.b / H
      b.norm = [clamp01(b.l / W), clamp01(Math.min(y0, y1)), clamp01(b.r / W), clamp01(Math.max(y0, y1))]
    }
  }
  return { page, bbox: b }
}

function docToBlocks(doc, { maxBlocks = 200000 } = {}) {
  const blocks = []
  const headings = [] // stack of {level, text}
  const seen = new Set()
  function visit(ref) {
    if (blocks.length >= maxBlocks || seen.has(ref)) return
    seen.add(ref)
    const r = resolve(doc, ref)
    if (!r || !r.item) return
    const { kind, item } = r
    if (kind === 'groups' || (kind === 'body')) {
      for (const ch of item.children || []) visit(ch.$ref || ch.cref)
      return
    }
    const label = item.label || (kind === 'tables' ? 'table' : kind === 'pictures' ? 'picture' : 'text')
    const type = TYPE_MAP[label] || 'paragraph'
    let text = ''
    let extra = null
    if (kind === 'tables') { text = tableText(item); extra = { grid: tableGrid(item) } }
    else if (kind === 'pictures') {
      text = (item.captions || []).map(c => { const x = resolve(doc, c.$ref || c.cref); return x && x.item ? x.item.text : '' }).join(' ')
    } else text = String(item.text || '')
    if (type === 'heading' || type === 'title') {
      const level = type === 'title' ? 0 : Number(item.level || 1)
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop()
      headings.push({ level, text: text.trim() })
    }
    const { page, bbox } = provOf(item, doc.pages)
    if (text.trim() || type === 'table' || type === 'picture') {
      blocks.push({
        seq: blocks.length, type, text,
        page, bbox,
        heading_path: headings.filter(h => h.text && !(h.text === text.trim() && (type === 'heading' || type === 'title'))).map(h => h.text),
        table: extra
      })
    }
    for (const ch of item.children || []) visit(ch.$ref || ch.cref)
  }
  const body = doc.body || {}
  for (const ch of body.children || []) visit(ch.$ref || ch.cref)
  return blocks
}

module.exports = { docToBlocks, tableText }
