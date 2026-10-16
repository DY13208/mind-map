const PLACEHOLDERS = new Set([
  '',
  '分支主题',
  '子主题',
  '概要',
  '中心主题',
  'branch topic',
  'sub topic',
  'central topic'
])

function stripText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function nodeText(node) {
  if (!node) return ''
  if (node.getData) return stripText(node.getData('text'))
  if (node.data && node.data.text != null) return stripText(node.data.text)
  return stripText(node.text)
}

// 知识节点标题前缀。W 后面紧跟数字（W1）不算前缀。
const WIKI_KNOWLEDGE_PREFIX_RE = /^W(?!\d)\s*[：:]\s*/i

/** 去掉知识节点的 W：，供检索组句和去重。C / P / D 不动。 */
export function stripWikiKnowledgePrefix(text) {
  return stripText(text).replace(WIKI_KNOWLEDGE_PREFIX_RE, '')
}

/** 保留旧调用入口；新写入仅显示正文，兼容移除旧 W 前缀。 */
export function withWikiKnowledgePrefix(text) {
  return stripWikiKnowledgePrefix(text)
}

function usefulTitle(text) {
  const value = stripWikiKnowledgePrefix(text)
  if (!value) return ''
  if (PLACEHOLDERS.has(value.toLowerCase())) return ''
  return value
}

/**
 * 从选中节点的父节点开始，沿 parent 一直走到根，再在末尾加上当前节点。
 * 占位标题（中心主题、分支主题等）不进入句子。知识节点的 W： 不进入检索句。
 */
export function wikiFillTitles(node) {
  const chain = []
  let cur = node && node.parent
  while (cur) {
    const title = usefulTitle(nodeText(cur))
    if (title) chain.unshift(title)
    cur = cur.parent
  }
  const self = usefulTitle(nodeText(node))
  if (self) chain.push(self)
  return chain
}

export function buildWikiFillQuery(node) {
  return wikiFillTitles(node).join('的')
}

export function wikiSearchUrl() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const base = String(runtime.graphServiceUrl || '/wiki-compiler/').trim()
  return (base || '/wiki-compiler/').replace(/\/?$/, '/') + 'api/search'
}

/** 把检索到的 Markdown 段落拆成子节点，不补写原文里没有的条款或页码。 */
export function contentToChildren(content) {
  const roots = []
  let heading = null
  for (const raw of String(content || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line === '---') continue
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line)
    if (headingMatch) {
      const text = stripText(headingMatch[2])
      if (!text) continue
      heading = { data: { text: text.slice(0, 500), kind: 'heading' }, children: [] }
      roots.push(heading)
      continue
    }
    const bullet = /^[-*•]\s+(.+)$/.exec(line)
    const text = stripText(
      bullet ? bullet[1] : line.replace(/^\d+[.)、]\s+/, '')
    )
    if (!text) continue
    const child = { data: { text: text.slice(0, 500) }, children: [] }
    if (heading) heading.children.push(child)
    else roots.push(child)
  }
  return roots
}

function queryTitles(query, titles) {
  if (Array.isArray(titles) && titles.length) {
    return titles.map(usefulTitle).filter(Boolean)
  }
  return String(query || '')
    .split('的')
    .map(usefulTitle)
    .filter(Boolean)
}

/** 编译标题上的覆盖率标记不参与和节点名对齐。 */
function sectionLabel(name) {
  return usefulTitle(name)
    .replace(/\s*\[coverage:[^\]]*\]/gi, '')
    .trim()
}

/**
 * 只认和某一级节点标题完全相同的名称。
 * 「合同」不能因为被「合同双方」包含就算命中。
 */
function nameInTitles(name, titles) {
  const value = sectionLabel(name)
  if (!value) return false
  return titles.some(title => title === value)
}

function resultsForSentence(results, query, titles) {
  const list = results || []
  const chain = queryTitles(query, titles)
  if (!chain.length) return list
  const topicHits = list.filter(item =>
    nameInTitles(item && (item.topic_title || item.topic), chain)
  )
  const scoped = topicHits.length ? topicHits : list
  const sectionHits = scoped
    .map(item => ({
      item,
      rank: sectionLabel(item && item.section).length
    }))
    .filter(row => nameInTitles(row.item && row.item.section, chain))
  if (sectionHits.length) {
    const best = Math.max(...sectionHits.map(row => row.rank))
    return sectionHits.filter(row => row.rank === best).map(row => row.item)
  }
  if (topicHits.length) return topicHits
  return []
}

function normalizeName(text) {
  return usefulTitle(text)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s\-—_·・:：/／]/g, '')
}

function longestCommon(left, right) {
  let best = 0
  const row = new Array(left.length + 1).fill(0)
  for (let i = 1; i <= right.length; i++) {
    let prev = 0
    for (let j = 1; j <= left.length; j++) {
      const next = left[j - 1] === right[i - 1] ? prev + 1 : 0
      prev = row[j]
      row[j] = next
      if (next > best) best = next
    }
  }
  return best
}

function headingMatches(heading, titles, exactOnly) {
  const text = normalizeName(heading)
  if (!text) return false
  return titles.some(title => {
    const name = normalizeName(title)
    if (!name || name.length < 4) return false
    if (text === name) return true
    if (exactOnly) return false
    if (text.includes(name) || name.includes(text)) return true
    const common = longestCommon(text, name)
    const shorter = Math.min(text.length, name.length)
    return common >= 4 && common / shorter >= 0.5
  })
}

const NODE_TEXT_LIMIT = 40

function clipText(text) {
  const value = stripText(text)
  const chars = Array.from(value)
  if (chars.length <= NODE_TEXT_LIMIT) return value
  return chars.slice(0, NODE_TEXT_LIMIT).join('')
}

function labelOf(text) {
  const value = stripText(text)
  const index = Math.max(value.indexOf('：'), value.indexOf(':'))
  if (index <= 0) return ''
  return value.slice(0, index).trim()
}

function valueOf(text) {
  const value = stripText(text)
  const label = labelOf(value)
  if (!label) return value
  const index = Math.max(value.indexOf('：'), value.indexOf(':'))
  return value.slice(index + 1).trim()
}

/** 相同字段名收成一条，多项用分号连接。 */
export function mergeSameField(lines) {
  const groups = []
  for (const line of lines || []) {
    const text = stripText(line)
    if (!text) continue
    const label = labelOf(text)
    const last = groups[groups.length - 1]
    if (label && last && last.label === label) {
      last.values.push(valueOf(text))
      continue
    }
    groups.push({
      label,
      values: [label ? valueOf(text) : text],
      text
    })
  }
  return groups.map(group => {
    if (!group.label || group.values.length === 1) return group.text
    return group.label + '：' + group.values.join('；')
  })
}

/**
 * 模型不可用时的整理。同一字段的竖线多项仍写在一条里。
 * 姓名、电话、邮箱单独带上自己的字段名。不按逗号拆。
 */
export function compactEvidence(lines) {
  const out = []
  for (const line of lines || []) {
    const parts = String(line || '')
      .split(/[｜|]/)
      .map(item => item.trim())
      .filter(Boolean)
    if (parts.length <= 1) {
      const text = clipText(line)
      if (text) out.push(text)
      continue
    }
    const label = labelOf(parts[0])
    const same = [valueOf(parts[0]) || parts[0]]
    const extras = []
    for (const part of parts.slice(1)) {
      if (part.includes('@')) extras.push(clipText('邮箱：' + part))
      else if (/^\+?\d[\d\s-]{6,}$/.test(part)) extras.push(clipText('电话：' + part))
      else if (/^[\u4e00-\u9fa5]{2,4}$/.test(part)) extras.push(clipText('联系人：' + part))
      else same.push(part)
    }
    const merged = label ? label + '：' + same.join('；') : same.join('；')
    if (merged) out.push(merged)
    extras.forEach(item => {
      if (item) out.push(item)
    })
  }
  return mergeSameField(out)
}

export function parseAbbreviatedLines(text) {
  const raw = String(text || '').trim()
  if (!raw) return []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let data
  try {
    data = JSON.parse(body.slice(start, end + 1))
  } catch (error) {
    return []
  }
  if (!Array.isArray(data)) return []
  const lines = []
  for (const item of data) {
    const value =
      typeof item === 'string' ? item : item && (item.text || item.label)
    const text = stripText(value)
    if (text) lines.push(text)
  }
  return mergeSameField(lines)
}

export function buildAbbreviateMessages(query, lines) {
  return [
    {
      role: 'system',
      content:
        '你只把已检索到的合同条目简写成思维导图子节点。不要补充材料里没有的事实，不要解释。只输出 JSON 字符串数组。'
    },
    {
      role: 'user',
      content: [
        '当前节点：' + query,
        '一个字段只写一条。同一字段里的多项用分号放进这一条，不要拆成多条同名字段。',
        '例如「关联期限：素材30天；分成30天；保价90天；发票60个工作日；逾期通知5日」。',
        '姓名、电话、邮箱可以各自成条，但必须带字段名，例如「联系人：陈永健」「电话：13266842296」。',
        '不要输出没有字段名的孤立词或残句。',
        '材料：',
        (lines || []).map((line, index) => index + 1 + '. ' + line).join('\n')
      ].join('\n')
    }
  ]
}

/**
 * 父级点了具体合同时只取那一份的原文条目。
 * 同一字段里有多份合同却对不上路径时，不把其他合同写进来。
 */
function linesForResult(content, titles) {
  const blocks = contentToChildren(content)
  const headings = blocks.filter(node => node.data && node.data.kind === 'heading')
  if (!headings.length) {
    return {
      matched: false,
      lines: blocks.map(node => stripText(node.data.text)).filter(Boolean)
    }
  }
  const exact = headings.filter(node =>
    headingMatches(node.data.text, titles, true)
  )
  const matched = exact.length
    ? exact
    : headings.filter(node => headingMatches(node.data.text, titles))
  if (!matched.length) return { matched: false, lines: [] }
  return {
    matched: true,
    lines: matched.flatMap(node =>
      (node.children || [])
        .map(child => stripText(child.data && child.data.text))
        .filter(Boolean)
    )
  }
}

export function resultsToChildTrees(results, existingTexts, query, titles) {
  const chain = queryTitles(query, titles)
  const seen = new Set(
    (existingTexts || []).map(text => usefulTitle(text)).filter(Boolean)
  )
  const rows = resultsForSentence(results, query, chain).map(item => ({
    item,
    ...linesForResult(item && item.content, chain)
  }))
  const chosen = rows.some(row => row.matched)
    ? rows.filter(row => row.matched)
    : rows
  const trees = []
  for (const row of chosen) {
    for (const line of row.lines) {
      const key = usefulTitle(line)
      if (!key || seen.has(key) || chain.includes(key)) continue
      trees.push({ data: { text: line }, children: [] })
      seen.add(key)
    }
  }
  return trees
}

export async function searchWikiCompiler(query, options = {}) {
  const text = String(query || '').trim()
  if (!text) {
    const error = new Error('无法根据父节点组句')
    error.code = 'EMPTY_QUERY'
    throw error
  }
  const fetchImpl = options.fetchImpl || fetch
  const response = await fetchImpl(options.url || wikiSearchUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: text, top_k: options.top_k || 8 }),
    signal: options.signal
  })
  let body = null
  try {
    body = await response.json()
  } catch (error) {
    body = null
  }
  if (!response.ok) {
    const message =
      (body && body.error) || 'Wiki 检索失败（' + response.status + '）'
    const error = new Error(message)
    error.status = response.status
    throw error
  }
  return {
    query: text,
    results: (body && body.results) || []
  }
}

/** 简写结果只写正文，与已有子节点按去掉旧前缀后的正文去重。 */
export function toKnowledgeChildTrees(lines, existingTexts) {
  const seen = new Set(
    (existingTexts || []).map(text => usefulTitle(text)).filter(Boolean)
  )
  const trees = []
  for (const line of lines || []) {
    const key = usefulTitle(line)
    if (!key || seen.has(key)) continue
    const text = withWikiKnowledgePrefix(line)
    if (!text) continue
    trees.push({ data: { text }, children: [] })
    seen.add(key)
  }
  return trees
}
