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

const looksLikeOutline = text => {
  const lines = String(text || '')
    .split(/\r\n|\n|\r/)
    .filter(line => line.trim())
  if (lines.length < 2) return false
  const marked = lines.filter(line => LIST_MARKER.test(line.trim())).length
  if (marked >= 2) return true
  const indents = lines.map(indentWidth)
  const min = Math.min(...indents)
  // A single indented line may be a continuation of a wrapped node title.
  // Repeated indentation (or a tab-delimited outline) provides a clearer tree signal.
  const nested = indents.filter(indent => indent > min)
  return nested.length >= 2 || lines.some(line => /^\t/.test(line))
}

export const parseIndentedOutline = text => {
  const lines = String(text || '')
    .split(/\r\n|\n|\r/)
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
  Array.from(clone.querySelectorAll('br')).forEach(br => {
    br.replaceWith(clone.ownerDocument.createTextNode('\n'))
  })
  return String(clone.textContent || '')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
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
  const opmlTextTree = parseOpmlTree(text)
  if (opmlTextTree.length) return opmlTextTree
  const opmlHtmlTree = parseOpmlTree(html)
  if (opmlHtmlTree.length) return opmlHtmlTree
  const htmlTree = parseHtmlListTree(html)
  if (htmlTree.length) return htmlTree
  return looksLikeOutline(text) ? parseIndentedOutline(text) : []
}
