function formatGetNodeGeneralizationLocal(data) {
  if (!data) return []
  const generalization = data.generalization
  if (!generalization) return []
  return Array.isArray(generalization) ? generalization : [generalization]
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim()
}

function walkDataNode(node, depth, lines) {
  if (!node || !node.data) return
  const text = stripHtml(node.data.text)
  if (text) lines.push('\t'.repeat(depth) + text)
  ;(node.children || []).forEach(child => walkDataNode(child, depth + 1, lines))
}

function walkTree(node, depth, lines) {
  if (!node || !node.data) return
  const text = stripHtml(node.data.text)
  if (text) lines.push('\t'.repeat(depth) + text)

  const genList = formatGetNodeGeneralizationLocal(node.data)
  genList.forEach(item => {
    const gText = stripHtml(item.text)
    if (gText) {
      lines.push('\t'.repeat(depth + 1) + `[概要] ${gText}`)
    }
    ;(item.children || []).forEach(child => walkDataNode(child, depth + 2, lines))
  })

  ;(node.children || []).forEach(child => walkTree(child, depth + 1, lines))
}

/** 节点树 → Tab 缩进大纲（知犀/钉钉/企业微信思维导图等通用） */
export function nodesToTabOutline(trees) {
  const lines = []
  const list = Array.isArray(trees) ? trees : [trees]
  list.filter(Boolean).forEach(tree => walkTree(tree, 0, lines))
  return lines.join('\n')
}

function dataNodeToHtml(node) {
  if (!node || !node.data) return ''
  const text = stripHtml(node.data.text)
  if (!text) return ''
  const kids = (node.children || [])
    .map(c => dataNodeToHtml(c))
    .filter(Boolean)
    .join('')
  return kids ? `<li>${text}<ul>${kids}</ul></li>` : `<li>${text}</li>`
}

function treeToHtml(node) {
  if (!node || !node.data) return ''
  const text = stripHtml(node.data.text)
  if (!text) return ''
  const parts = []
  const genList = formatGetNodeGeneralizationLocal(node.data)
  genList.forEach(item => {
    const gText = stripHtml(item.text)
    if (!gText) return
    const gKids = (item.children || [])
      .map(c => dataNodeToHtml(c))
      .filter(Boolean)
      .join('')
    parts.push(
      gKids
        ? `<li>[概要] ${gText}<ul>${gKids}</ul></li>`
        : `<li>[概要] ${gText}</li>`
    )
  })
  ;(node.children || []).forEach(child => {
    const h = treeToHtml(child)
    if (h) parts.push(h)
  })
  return parts.length
    ? `<li>${text}<ul>${parts.join('')}</ul></li>`
    : `<li>${text}</li>`
}

/** 节点树 → HTML 嵌套列表（部分应用粘贴更友好） */
export function nodesToOutlineHtml(trees) {
  const list = Array.isArray(trees) ? trees : [trees]
  const body = list
    .filter(Boolean)
    .map(tree => treeToHtml(tree))
    .filter(Boolean)
    .join('')
  if (!body) return ''
  return `<ul>${body}</ul>`
}

export function clipboardTextLooksLikeOutline(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter(line => line.trim())
  if (lines.length < 2) return false
  return lines.some(line => /^\t/.test(line) || /^\s{2,}\S/.test(line))
}
