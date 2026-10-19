const LABEL_KIND = {
  title: 'heading',
  section_header: 'heading',
  paragraph: 'paragraph',
  text: 'paragraph',
  list_item: 'list_item',
  caption: 'paragraph',
  formula: 'paragraph',
  code: 'paragraph',
  footnote: 'paragraph',
  reference: 'paragraph',
  page_header: 'page_header',
  page_footer: 'page_footer',
  table: 'table',
  document_index: 'paragraph',
  checkbox_selected: 'paragraph',
  checkbox_unselected: 'paragraph',
  picture: 'picture',
  chart: 'picture'
}

function refOf(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  return node.$ref || node.self_ref || ''
}

function sourceOf(item) {
  const prov = Array.isArray(item && item.prov) ? item.prov[0] : null
  if (!prov || typeof prov !== 'object') return {}
  const source = {}
  if (prov.page_no != null) source.page_no = prov.page_no
  if (prov.bbox) source.bbox = prov.bbox
  if (prov.charspan) source.charspan = prov.charspan
  return source
}

function mapDocument(doc) {
  const report = { unrecognized: [], empty: [] }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    report.unrecognized.push('document')
    return { blocks: [], plainText: '', report, parserVersion: '' }
  }
  const blocks = []
  const seen = new Set()

  function add(block) {
    if (!block.blockKey || seen.has(block.blockKey)) return
    seen.add(block.blockKey)
    block.ordinal = blocks.length
    blocks.push(block)
  }

  function resolve(ref) {
    const match = String(ref || '').match(
      /^#\/(texts|tables|pictures|groups|key_value_items|form_items)\/(\d+)$/
    )
    if (!match) return null
    const collection = match[1]
    const index = Number(match[2])
    const list = doc[collection]
    if (!Array.isArray(list) || !list[index]) return { missing: true, ref: String(ref) }
    return { collection, item: list[index], ref: String(ref) }
  }

  function walk(ref, parentKey) {
    const resolved = resolve(ref)
    if (!resolved || resolved.missing) {
      if (ref) report.unrecognized.push(String(ref))
      return
    }
    const item = resolved.item
    const key = String(item.self_ref || resolved.ref).replace(/^#\//, '')
    if (resolved.collection === 'groups') {
      add({
        blockKey: key,
        parentBlockKey: parentKey,
        kind: 'group',
        text: String(item.name || item.label || ''),
        raw: item,
        source: sourceOf(item)
      })
      for (const child of item.children || []) walk(refOf(child), key)
      return
    }
    if (resolved.collection === 'tables') {
      const cells = (item.data && item.data.table_cells) || []
      add({
        blockKey: key,
        parentBlockKey: parentKey,
        kind: 'table',
        text: cells.map(cell => String(cell.text || '')).join('\t'),
        raw: item,
        source: sourceOf(item)
      })
      cells.forEach((cell, index) => {
        const cellKey = `${key}/cells/${index}`
        if (!String(cell.text || '').trim()) report.empty.push(cellKey)
        add({
          blockKey: cellKey,
          parentBlockKey: key,
          kind: 'table_cell',
          text: String(cell.text || ''),
          raw: cell,
          source: sourceOf(item)
        })
      })
      for (const child of item.children || []) walk(refOf(child), key)
      return
    }
    if (resolved.collection === 'key_value_items' || resolved.collection === 'form_items') {
      const text = [item.key, item.value, item.text]
        .filter(value => value != null && value !== '')
        .map(value => String(value))
        .join(': ')
      add({
        blockKey: key,
        parentBlockKey: parentKey,
        kind: 'attribute',
        text,
        raw: item,
        source: sourceOf(item)
      })
      return
    }
    const label = String(item.label || '')
    let kind = LABEL_KIND[label]
    if (!kind) {
      kind = resolved.collection === 'pictures' ? 'picture' : 'unknown'
      report.unrecognized.push(`${key}:${label || resolved.collection}`)
    }
    const text = String(item.text || item.orig || '')
    if (!text && kind !== 'picture') report.empty.push(key)
    add({
      blockKey: key,
      parentBlockKey: parentKey,
      kind,
      text,
      raw: item,
      source: sourceOf(item)
    })
    for (const child of item.children || []) walk(refOf(child), key)
  }

  const bodyChildren = (doc.body && doc.body.children) || []
  if (bodyChildren.length) {
    bodyChildren.forEach(child => walk(refOf(child), null))
  } else {
    ;['texts', 'tables', 'pictures', 'key_value_items', 'form_items'].forEach(name => {
      ;(doc[name] || []).forEach((_, index) => walk(`#/${name}/${index}`, null))
    })
  }
  ;((doc.furniture && doc.furniture.children) || []).forEach(child => walk(refOf(child), null))

  const plainText = blocks
    .filter(block => block.kind !== 'table_cell' && block.text)
    .map(block => block.text)
    .join('\n')
  return {
    blocks,
    plainText,
    report,
    parserVersion: String(doc.version || '')
  }
}

module.exports = { mapDocument, LABEL_KIND }
