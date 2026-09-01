const LIST_MARKER = /^(?:[-*+•●○]\s+|\d+[.)]\s+|#{1,6}\s+)/

const gcd = (a, b) => {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) {
    const t = y
    y = x % y
    x = t
  }
  return x || 1
}

const indentWidth = line => {
  let n = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\t') n += 4
    else if (ch === ' ' || ch === '\u00a0') n += 1
    else break
  }
  return n
}

const stripMarker = text => {
  return String(text || '')
    .replace(LIST_MARKER, '')
    .trim()
}

const walkScore = (nodes, acc = { n: 0, nested: 0 }) => {
  ;(nodes || []).forEach(node => {
    acc.n += 1
    const children = node && node.children
    if (children && children.length) {
      acc.nested += children.length
      walkScore(children, acc)
    }
  })
  return acc
}

const scoreTree = nodes => {
  const acc = walkScore(nodes)
  return acc.nested * 10 + acc.n
}

const looksLikeOutline = text => {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter(line => line.trim())
  if (lines.length < 2) return false
  const hasIndent = lines.some(line => indentWidth(line) > 0)
  const marked = lines.filter(line => LIST_MARKER.test(line.trim())).length
  return hasIndent || marked >= 2
}

export const parseIndentedOutline = text => {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => ({
      indent: indentWidth(line),
      text: stripMarker(line.trim())
    }))
    .filter(item => item.text)
  if (!lines.length) return []
  const min = Math.min(...lines.map(item => item.indent))
  lines.forEach(item => {
    item.indent -= min
  })
  const nonzero = [
    ...new Set(lines.map(item => item.indent).filter(item => item > 0))
  ]
  const unit = nonzero.length ? nonzero.reduce((a, b) => gcd(a, b)) : 1
  const roots = []
  const stack = []
  lines.forEach(item => {
    const level = unit ? Math.round(item.indent / unit) : 0
    const node = {
      data: { text: item.text },
      children: []
    }
    while (stack.length && stack[stack.length - 1].level >= level) {
      stack.pop()
    }
    if (!stack.length) {
      roots.push(node)
    } else {
      stack[stack.length - 1].node.children.push(node)
    }
    stack.push({ level, node })
  })
  return roots
}

const collectLiText = li => {
  const clone = li.cloneNode(true)
  Array.from(clone.querySelectorAll('ul, ol')).forEach(list => {
    list.remove()
  })
  return String(clone.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
}

const walkList = listEl => {
  const nodes = []
  Array.from(listEl.children).forEach(li => {
    if (!li || String(li.tagName).toLowerCase() !== 'li') return
    const node = {
      data: { text: collectLiText(li) },
      children: []
    }
    Array.from(li.children).forEach(child => {
      const tag = String(child.tagName || '').toLowerCase()
      if (tag === 'ul' || tag === 'ol') {
        node.children.push(...walkList(child))
      }
    })
    if (node.data.text || node.children.length) {
      nodes.push(node)
    }
  })
  return nodes
}

export const parseHtmlListTree = html => {
  if (!html || !/<li[\s>]/i.test(html)) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const lists = Array.from(doc.querySelectorAll('ul, ol')).filter(list => {
    const parent = list.parentElement
    return !parent || String(parent.tagName).toLowerCase() !== 'li'
  })
  const roots = []
  lists.forEach(list => {
    roots.push(...walkList(list))
  })
  return roots
}

export const parseOpmlTree = xml => {
  if (!xml || !/<outline[\s>]/i.test(xml)) return []
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  if (doc.querySelector('parsererror')) return []
  const walkOutline = outline => {
    const text =
      outline.getAttribute('text') || outline.getAttribute('title') || ''
    const node = {
      data: { text: String(text).trim() },
      children: []
    }
    Array.from(outline.children).forEach(child => {
      if (String(child.tagName || '').toLowerCase() === 'outline') {
        node.children.push(walkOutline(child))
      }
    })
    return node
  }
  const roots = Array.from(
    doc.querySelectorAll('body > outline, opml > body > outline')
  )
  if (roots.length) return roots.map(walkOutline)
  return Array.from(doc.getElementsByTagName('outline'))
    .filter(node => {
      const parent = node.parentElement
      return !parent || String(parent.tagName).toLowerCase() !== 'outline'
    })
    .map(walkOutline)
}

export const parseClipboardToNodes = (text = '', html = '') => {
  const htmlTree = parseHtmlListTree(html)
  const opmlTree = parseOpmlTree(text) || parseOpmlTree(html)
  const textTree = looksLikeOutline(text) ? parseIndentedOutline(text) : []
  const candidates = [
    { tree: htmlTree, score: scoreTree(htmlTree) },
    { tree: opmlTree, score: scoreTree(opmlTree) },
    { tree: textTree, score: scoreTree(textTree) }
  ].sort((a, b) => b.score - a.score)
  const best = candidates[0]
  if (!best || !best.tree.length) return []
  if (best.score < 2 && !looksLikeOutline(text) && !htmlTree.length) return []
  return best.tree
}
