import { transformMarkdownTo } from 'simple-mind-map/src/parse/markdownTo'

/** 尝试修复被截断的 JSON（常见于大 children） */
export function repairJsonText(text) {
  let s = String(text || '').trim()
  if (!s) return null
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()

  const tryParse = raw => {
    try {
      return JSON.parse(raw)
    } catch (e) {
      return null
    }
  }

  let parsed = tryParse(s)
  if (parsed) return parsed

  // 从第一个 { 或 [ 起截
  const objStart = s.indexOf('{')
  const arrStart = s.indexOf('[')
  if (objStart < 0 && arrStart < 0) return null
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    s = s.slice(objStart)
  } else {
    s = s.slice(arrStart)
  }

  parsed = tryParse(s)
  if (parsed) return parsed

  // 补全缺失引号/括号
  let fixed = s
  const quoteCount = (fixed.match(/"/g) || []).length
  if (quoteCount % 2 === 1) fixed += '"'
  const openCurly = (fixed.match(/{/g) || []).length
  const closeCurly = (fixed.match(/}/g) || []).length
  const openSquare = (fixed.match(/\[/g) || []).length
  const closeSquare = (fixed.match(/]/g) || []).length
  // 去掉末尾悬空逗号
  fixed = fixed.replace(/,\s*$/, '')
  for (let i = 0; i < openSquare - closeSquare; i++) fixed += ']'
  for (let i = 0; i < openCurly - closeCurly; i++) fixed += '}'

  parsed = tryParse(fixed)
  if (parsed) return parsed

  // 再激进一点：截到最后一个完整对象边界
  const lastBrace = Math.max(fixed.lastIndexOf('}'), fixed.lastIndexOf(']'))
  if (lastBrace > 0) {
    parsed = tryParse(fixed.slice(0, lastBrace + 1))
    if (parsed) return parsed
  }
  return null
}

export function extractJson(text) {
  if (!text) return null
  const raw = String(text)
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = []
  if (fence) candidates.push(fence[1].trim())
  candidates.push(raw.trim())

  const objStart = raw.indexOf('{')
  const arrStart = raw.indexOf('[')
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    candidates.push(raw.slice(objStart, raw.lastIndexOf('}') + 1))
  } else if (arrStart >= 0) {
    candidates.push(raw.slice(arrStart, raw.lastIndexOf(']') + 1))
  }

  for (const candidate of candidates) {
    if (!candidate) continue
    const parsed = repairJsonText(candidate)
    if (parsed) return parsed
  }
  return repairJsonText(raw)
}

function normalizeArguments(args) {
  if (args == null) return null
  if (typeof args === 'object') return args
  if (typeof args === 'string') {
    const parsed = extractJson(args)
    return parsed != null ? parsed : args
  }
  return args
}

/** 统一成 { name, arguments } */
export function normalizeToolCalls(calls) {
  if (!Array.isArray(calls)) return []
  return calls
    .map(call => {
      if (!call) return null
      const fn = call.function || call
      return {
        id: call.id || '',
        name: fn.name || call.name || '',
        arguments:
          fn.arguments != null
            ? fn.arguments
            : fn.input != null
              ? fn.input
              : call.arguments != null
                ? call.arguments
                : call.input != null
                  ? call.input
                  : call.result
      }
    })
    .filter(Boolean)
}

export function toChildTree(item) {
  if (item == null) return null
  if (typeof item === 'string') {
    const text = item.trim()
    return text ? { data: { text }, children: [] } : null
  }
  const data = item.data && typeof item.data === 'object' ? item.data : item
  const text = String(data.text || data.title || data.label || '').trim()
  if (!text) return null
  const node = { data: { text }, children: [] }
  if (data.note) node.data.note = String(data.note)
  if (data.generalization) node.data.generalization = data.generalization
  const kids = Array.isArray(item.children)
    ? item.children
    : Array.isArray(data.children)
      ? data.children
      : []
  node.children = kids.map(toChildTree).filter(Boolean)
  return node
}

export function childrenFromPayload(payload) {
  if (!payload) return []
  if (Array.isArray(payload)) {
    return payload.map(toChildTree).filter(Boolean)
  }
  if (typeof payload === 'string') {
    const parsed = extractJson(payload)
    return parsed ? childrenFromPayload(parsed) : []
  }

  const directKeys = ['children', 'nodes', 'items', 'subnodes', 'sub_nodes']
  for (const key of directKeys) {
    if (Array.isArray(payload[key]) && payload[key].length) {
      const list = payload[key].map(toChildTree).filter(Boolean)
      if (list.length) return list
    }
  }

  if (payload.data && payload.data.text) {
    const tree = toChildTree(payload)
    return tree ? [tree] : []
  }

  const calls = normalizeToolCalls(
    (Array.isArray(payload.calls) && payload.calls) ||
      (Array.isArray(payload.tool_calls) && payload.tool_calls) ||
      []
  )
  for (const call of calls) {
    const args = normalizeArguments(call.arguments)
    const list = childrenFromPayload(args)
    if (list.length) return list
  }

  if (payload.type === 'tool_calls' && Array.isArray(payload.calls)) {
    return childrenFromPayload({ calls: payload.calls })
  }

  if (payload.type === 'final' && payload.content) {
    return childrenFromPayload(extractJson(payload.content) || payload.content)
  }

  if (payload.name && (payload.arguments || payload.input)) {
    return childrenFromPayload(
      normalizeArguments(payload.arguments || payload.input)
    )
  }

  return []
}

function parseMarkdownBullets(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.replace(/\t/g, '  '))
  const root = []
  const stack = [{ depth: -1, children: root }]
  lines.forEach(line => {
    const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/)
    if (!m) return
    const depth = Math.floor(m[1].length / 2)
    const textPart = m[3].replace(/\*\*/g, '').trim()
    if (!textPart) return
    const node = { data: { text: textPart }, children: [] }
    while (stack.length && stack[stack.length - 1].depth >= depth) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    parent.children.push(node)
    stack.push({ depth, children: node.children })
  })
  return root
}

/** 从 WorkBuddy / OpenAI 响应中解析可插入的子节点树 */
export function parseMindmapChildren(result) {
  if (!result) return []

  const calls = normalizeToolCalls(
    (result.toolCalls || []).concat(result.eventToolCalls || [])
  )
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i] || {}
    const args = normalizeArguments(call.arguments)
    const list = childrenFromPayload(args)
    if (list.length) return list
  }

  const events = result.events || []
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev) continue
    if (ev.type === 'workbuddy.tool_result') {
      const list = childrenFromPayload(ev.result || ev.text || ev.input)
      if (list.length) return list
    }
    if (ev.type === 'workbuddy.tool_call') {
      const list = childrenFromPayload(ev.input || ev.rawInput)
      if (list.length) return list
    }
  }

  const json = extractJson(result.content)
  const fromJson = childrenFromPayload(json)
  if (fromJson.length) return fromJson

  const md = String(result.content || '').trim()
  if (!md) return []
  try {
    const tree = transformMarkdownTo(md)
    const fromMd = childrenFromPayload(tree)
    if (fromMd.length) return fromMd
  } catch (e) {
    /* fall through */
  }
  return parseMarkdownBullets(md)
}

export function describeParseMiss(result) {
  const calls = normalizeToolCalls(
    ((result && result.toolCalls) || []).concat(
      (result && result.eventToolCalls) || []
    )
  )
  const content = String((result && result.content) || '')
  return {
    toolCallCount: calls.length,
    toolNames: calls.map(c => c.name).filter(Boolean),
    argPreview: calls[0]
      ? String(
          typeof calls[0].arguments === 'string'
            ? calls[0].arguments
            : JSON.stringify(calls[0].arguments || '')
        ).slice(0, 240)
      : '',
    contentPreview: content.slice(0, 240),
    eventCount: ((result && result.events) || []).length
  }
}
