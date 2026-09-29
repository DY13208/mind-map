'use strict'

const crypto = require('crypto')
const { issueKnowledgeMcpToken } = require('../knowledgeMcpToken')
const { searchRoomNodes } = require('../roomNodes')
const { createWikiProvider } = require('./wikiProvider')
const { sourceIdFor } = require('./identity')
const chainUtils = require('./chain')

const MAX_QUERY_CHARS = 240
const MAX_CANDIDATES = 30
const MAX_CANONICAL_DOCS = 40
const MAX_READ_NODES = 400
const MAX_READ_DEPTH = 48
const MAX_READ_ATTACHMENTS = 50
const MAX_SOURCE_CHARS = 200000
const MCP_READ_TOOLS = new Set([
  'canonical_list',
  'canonical_read',
  'docmost_search',
  'docmost_get',
  'openwiki_search',
  'openwiki_read'
])

function statusResult(status, extra = {}) {
  return { status, ...extra }
}

function cleanText(value, max = MAX_SOURCE_CHARS) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\t\r\n ]+/g, ' ')
    .trim()
    .slice(0, max)
}

function cleanNodeText(value, max = MAX_SOURCE_CHARS) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function cleanNoteText(value, max = MAX_SOURCE_CHARS) {
  return String(value == null ? '' : value)
    .replace(/<(?:br\s*\/?|\/p|\/li|\/div)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, max)
}

function queryTerms(query) {
  const raw = String(query || '').trim().toLocaleLowerCase()
  if (!raw) return []
  const terms = raw.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
  const useful = terms.filter(term => [...term].length > 1)
  return [...new Set(useful.length ? useful : [raw])].slice(0, 8)
}

function findMatchReason(query, text) {
  const haystack = cleanText(text).toLocaleLowerCase()
  const terms = queryTerms(query)
  const found = terms.filter(term => haystack.includes(term))
  if (!found.length) return ''
  return `内容包含 ${found.length}/${terms.length} 个检索词：${found.join('、')}`
}

function excerptFor(query, text, max = 260) {
  const source = cleanText(text)
  const lower = source.toLocaleLowerCase()
  const terms = queryTerms(query)
  let at = -1
  for (const term of terms) {
    at = lower.indexOf(term)
    if (at >= 0) break
  }
  if (at < 0 || source.length <= max) return source.slice(0, max)
  const start = Math.max(0, at - Math.floor(max / 3))
  return `${start ? '…' : ''}${source.slice(start, start + max)}${start + max < source.length ? '…' : ''}`
}

function stableCandidateId(sourceRef) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sourceRef))
    .digest('hex')
    .slice(0, 24)
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}

function actorId(actor) {
  return String((actor && (actor.id || actor.userId || actor.sub)) || '').trim()
}

function safeRoomKey(roomKey) {
  return typeof roomKey === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(roomKey)
}

function getNodeData(node) {
  if (!node || typeof node !== 'object') return {}
  return node.data && typeof node.data === 'object' ? node.data : node
}

function nodeUid(node, fallback = '') {
  return String((node && (node.uid || node.id || node.data && node.data.uid)) || fallback || '')
}

function nodeStrings(node) {
  const data = getNodeData(node)
  const values = [
    data.text,
    data.note,
    data.attachmentText,
    data.extractedText,
    data.attachmentBody,
    data.content,
    data.body,
    data.title,
    node && node.attachmentText,
    node && node.extractedText,
    node && node.attachmentBody,
    node && node.content,
    node && node.body
  ]
  if (Array.isArray(data.attachments)) {
    data.attachments.forEach(item => {
      if (typeof item === 'string') values.push(item)
      else if (item && typeof item === 'object') {
        values.push(item.text, item.extractedText, item.body, item.content)
      }
    })
  }
  return values.map(value => cleanText(value)).filter(Boolean)
}

function flattenChain(chain) {
  if (!chain || typeof chain !== 'object') return []
  const records = new Map()
  const seenObjects = new Set()

  const add = (node, fallbackUid, inheritedPath = []) => {
    if (!node || typeof node !== 'object' || seenObjects.has(node)) return
    seenObjects.add(node)
    const uid = nodeUid(node, fallbackUid)
    const data = getNodeData(node)
    const text = cleanNodeText(data.text || node.text || data.title || node.title || '')
    const note = cleanNoteText(data.note || node.note || '')
    const pathValue = Array.isArray(node.path)
      ? node.path.map(part => typeof part === 'string' ? part : cleanText(part && (part.text || part.title || part.uid)))
      : inheritedPath
    const fields = nodeStrings(node)
    if (uid && (text || note || fields.length)) {
      const previous = records.get(uid)
      records.set(uid, {
        uid,
        title: previous && previous.title || text || note.slice(0, 120) || uid,
        text: previous && previous.text || text,
        note: previous && previous.note || note,
        path: previous && previous.path.length ? previous.path : pathValue.filter(Boolean),
        searchableText: [...new Set([previous && previous.searchableText, fields.join('\n')].filter(Boolean))].join('\n')
      })
    }
    const children = Array.isArray(node.children) ? node.children : []
    children.forEach(child => {
      if (child && typeof child === 'object') {
        add(child, nodeUid(child), [...pathValue, text || uid].filter(Boolean))
      }
    })
  }

  const candidates = [chain.nodes, chain.chain, chain.tree, chain.root, chain]
  candidates.forEach(candidate => {
    if (Array.isArray(candidate)) {
      candidate.forEach(node => add(node, nodeUid(node)))
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    // mindDoc snapshots may expose a uid-keyed graph whose children are uid strings.
    const entries = Object.entries(candidate)
    const graphEntries = entries.filter(([, value]) =>
      value && typeof value === 'object' && !Array.isArray(value) &&
      (value.data || Array.isArray(value.children))
    )
    if (graphEntries.length && graphEntries.length === entries.length) {
      graphEntries.forEach(([uid, node]) => add({ ...node, uid }, uid))
      return
    }
    if (candidate.data || Array.isArray(candidate.children) || candidate.uid) {
      add(candidate, nodeUid(candidate))
    }
  })

  // The checker service passes a compact chain description (path/check/plan/
  // execution) rather than the whole map. Preserve those scoped records so a
  // chain-local search never needs to inspect unrelated room nodes.
  const compactPath = Array.isArray(chain.path)
    ? chain.path.map(part => typeof part === 'string' ? part : cleanText(part && (part.text || part.title || part.uid))).filter(Boolean)
    : []
  for (const group of ['check', 'plan', 'execution']) {
    for (const item of Array.isArray(chain[group]) ? chain[group] : []) {
      if (!item || typeof item !== 'object') continue
      const uid = nodeUid(item)
      if (!uid) continue
      add({ ...item, path: item.path || compactPath }, uid, compactPath)
    }
  }

  const allowedUids = Array.isArray(chain.nodeUids) ? new Set(chain.nodeUids.map(String)) : null
  return [...records.values()].filter(record => !allowedUids || allowedUids.has(record.uid))
}

function classifyCandidateKind({ title = '', path: candidatePath = '', content = '', sourceRef = null } = {}) {
  const full = `${title}\n${candidatePath}\n${content}`
  // Map subtree reads render each node as `- [uid] C：...`; normalize those
  // bullets/UIDs before checking role headings, while preserving line breaks.
  const lines = full.split(/\r?\n/).map(line => line
    .replace(/^\s*(?:(?:[-*+]\s*)|(?:\d+[.)、]\s*))?(?:\[[^\]]+\]\s*)?/, '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\*\*|__/g, '')
    .trim())
  const hasRole = (letter, aliases) => lines.some(line =>
    new RegExp(`^(?:${letter}\\s*(?:[:：]|$)|(?:${aliases})\\s*(?:[:：]|$))`, 'i').test(line)
  )
  const hasC = hasRole('C', '检查|目标')
  const hasP = hasRole('P', '计划')
  const hasD = hasRole('D', '执行|动作')
  if (hasC && hasP && hasD) return 'flow'
  if (/(?:附件|项目材料|验收报告|检查报告|数据明细|原始记录|会议纪要|标准知识|业务制度|项目需求)/i.test(`${title} ${candidatePath}`)) return 'material'
  // An isolated map node or partial source does not establish a full CPD.
  return sourceRef && sourceRef.type === 'map_node' ? 'unknown' : 'unknown'
}

function sourceRoleFor(source, derived) {
  if (source === 'chain') return 'current_chain'
  if (source === 'map_knowledge') return 'room_map'
  if (derived) return 'derived'
  if (source === 'canonical') return 'canonical'
  if (source === 'docmost') return 'mapped_docmost'
  if (source === 'openwiki') return 'derived'
  return 'unknown'
}

function sourceAuthority(data, sourceType) {
  const authority = String(data && data.authority || '').trim().toLowerCase()
  const derived = Boolean(data && data.derived) || /(?:ai-derived|formal-mirror|derived|mirror)/.test(authority) || sourceType === 'openwiki'
  const independentEvidence = !derived && (
    sourceType === 'canonical' || authority === 'formal' || authority === 'human-supplement'
  )
  return { derived, independentEvidence }
}

function makeCandidate({ roomKey, sourceRef, title, path: candidatePath, source, matchReason, summary, version, sourceHash = null, complete = false, derived = false, independentEvidence = true, kind = 'unknown', sourceRole = null, provenance = null, referenceDetails = null, fieldCoverage = null }) {
  const normalizedSourceRef = sourceRef && typeof sourceRef === 'object'
    ? { ...sourceRef, sourceId: sourceIdFor(sourceRef) }
    : sourceRef
  const normalizedTitle = cleanText(title || '(无标题)', 160)
  const normalizedPath = Array.isArray(candidatePath) ? candidatePath.filter(Boolean).join(' / ') : cleanText(candidatePath || '', 400)
  return {
    candidateId: stableCandidateId(normalizedSourceRef),
    sourceId: sourceIdFor(normalizedSourceRef),
    sourceRef: normalizedSourceRef,
    title: normalizedTitle,
    path: normalizedPath,
    source,
    matchReason: cleanText(matchReason || '', 320),
    summary: cleanText(summary || '', 320),
    version: version == null ? null : String(version),
    sourceHash: sourceHash || null,
    complete: Boolean(complete),
    kind: ['flow', 'material', 'unknown'].includes(kind) ? kind : 'unknown',
    sourceRole: sourceRole || sourceRoleFor(source, derived),
    derived: Boolean(derived),
    independentEvidence: Boolean(independentEvidence),
    ...(provenance && typeof provenance === 'object' ? { provenance } : {}),
    ...(referenceDetails && typeof referenceDetails === 'object' ? { referenceDetails } : {}),
    ...(fieldCoverage && typeof fieldCoverage === 'object' ? fieldCoverage : {}),
    roomKey
  }
}

function mapMcpError(error) {
  const code = String(error && (error.code || error.error) || '').toLowerCase()
  if (/forbidden|unauthorized|invalid_token|expired|bad_signature|acl/.test(code)) return 'forbidden'
  if (/not_found|no_results|not_created/.test(code)) return 'no_results'
  if (/unavailable|unreachable|unconfigured|not_connected|wiki_identity/.test(code)) return 'unavailable'
  return 'error'
}

function parseJsonText(text) {
  if (typeof text !== 'string') return text
  try { return JSON.parse(text) } catch { return null }
}

function mcpResultPayload(response) {
  if (!response || typeof response !== 'object') return { error: { code: 'invalid_response' } }
  const rpcError = response.error || response.result && response.result.error
  if (rpcError) return { error: rpcError }
  const result = response.result || response
  const textContent = Array.isArray(result.content)
    ? result.content.find(item => item && item.type === 'text' && typeof item.text === 'string')
    : null
  const payload = textContent ? parseJsonText(textContent.text) : result
  if (result.isError || payload && payload.error) {
    return { error: payload && payload.error ? payload : { code: 'tool_error' } }
  }
  return { value: payload }
}

function resolveKnowledgeMcpUrl(env) {
  const explicit = String(env.CPD_CHECK_KNOWLEDGE_MCP_URL || env.KNOWLEDGE_MCP_URL || '').trim()
  if (explicit) return explicit
  return env.GATEWAY === '1'
    ? 'http://knowledge-mcp:18792/mcp'
    : 'http://127.0.0.1:18792/mcp'
}

async function readResponseLimited(response, maxBytes) {
  const declared = Number(response.headers && response.headers.get && response.headers.get('content-length'))
  if (declared > maxBytes) throw Object.assign(new Error('response_too_large'), { code: 'response_too_large' })
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw Object.assign(new Error('response_too_large'), { code: 'response_too_large' })
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock && reader.releaseLock()
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw Object.assign(new Error('response_too_large'), { code: 'response_too_large' })
  }
  return body
}

function combineAbortSignals(...signals) {
  const active = signals.filter(Boolean)
  const controller = new AbortController()
  const listeners = []
  active.forEach(signal => {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return
    }
    const listener = () => controller.abort(signal.reason)
    signal.addEventListener('abort', listener, { once: true })
    listeners.push([signal, listener])
  })
  return {
    signal: controller.signal,
    dispose() {
      listeners.forEach(([signal, listener]) => signal.removeEventListener('abort', listener))
    }
  }
}

function createKnowledgeClient({ env, fetchImpl, tokenIssuer, timeoutMs = 12000, signal: externalSignal }) {
  let sequence = 0
  return async function callKnowledgeTool(actor, toolName, args) {
    if (!MCP_READ_TOOLS.has(toolName)) {
      return statusResult('error', { error: 'read_only_tool_not_allowed' })
    }
    const id = actorId(actor)
    if (!id) return statusResult('forbidden', { error: 'missing_user_identity' })
    const token = tokenIssuer(id, env)
    if (!token) return statusResult('unavailable', { error: 'knowledge_mcp_auth_unconfigured' })
    const url = resolveKnowledgeMcpUrl(env)
    let parsedUrl
    try { parsedUrl = new URL(url) } catch { return statusResult('unavailable', { error: 'knowledge_mcp_url_invalid' }) }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return statusResult('unavailable', { error: 'knowledge_mcp_url_invalid' })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const linked = combineAbortSignals(controller.signal, externalSignal)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++sequence,
          method: 'tools/call',
          params: { name: toolName, arguments: args }
        }),
        signal: linked.signal
      })
      const body = await readResponseLimited(response, 1024 * 1024)
      let json
      try { json = JSON.parse(body) } catch { return statusResult('error', { error: 'knowledge_mcp_invalid_json' }) }
      if (response.status === 401 || response.status === 403) {
        return statusResult('forbidden', { error: response.status === 401 ? 'knowledge_mcp_unauthorized' : 'forbidden' })
      }
      if (!response.ok) {
        return statusResult(response.status >= 500 ? 'unavailable' : 'error', {
          error: String((json && (json.error || json.message)) || `knowledge_mcp_http_${response.status}`).slice(0, 120)
        })
      }
      const parsed = mcpResultPayload(json)
      if (parsed.error) {
        const error = parsed.error
        const code = String(error.error || error.code || error.message || 'knowledge_mcp_error')
        return statusResult(mapMcpError({ code }), { error: code.slice(0, 120) })
      }
      return statusResult('ok', { value: parsed.value })
    } catch (error) {
      const name = String(error && error.name || '')
      const code = String(error && error.code || '')
      return statusResult('unavailable', {
        error: externalSignal && externalSignal.aborted
          ? 'request_aborted'
          : name === 'AbortError' ? 'knowledge_mcp_timeout' : code === 'response_too_large' ? code : 'knowledge_mcp_unreachable'
      })
    } finally {
      clearTimeout(timer)
      linked.dispose()
    }
  }
}

function createCheckProviders(options = {}) {
  const env = options.env || process.env
  const db = options.db || null
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const tokenIssuer = options.tokenIssuer || issueKnowledgeMcpToken
  const signal = options.signal
  const nodeSearch = options.searchRoomNodes || searchRoomNodes
  const knowledgeCall = options.callKnowledgeTool || createKnowledgeClient({
    env,
    fetchImpl,
    tokenIssuer,
    timeoutMs: options.knowledgeTimeoutMs || 12000,
    signal
  })
  const wiki = createWikiProvider({
    env,
    fetchImpl,
    timeoutMs: options.wikiTimeoutMs || 8000,
    signal
  })
  async function searchSources({ roomKey, query, scope, chain, actor, mode = 'business', requestCache } = {}) {
    if (signal && signal.aborted) return statusResult('unavailable', { error: 'request_aborted', candidates: [], complete: false })
    const q = String(query || '').trim().slice(0, MAX_QUERY_CHARS)
    if (!safeRoomKey(roomKey) || !q) return statusResult('error', { error: 'invalid_room_or_query', candidates: [] })

    if (scope === 'wiki') {
      const found = await wiki.searchSources({ roomKey, query: q, mode, actor, requestCache })
      if (found.status !== 'ok') return { ...found, source: 'wiki' }
      return {
        ...found,
        source: 'wiki',
        candidates: found.candidates.map(candidate => makeCandidate({
          roomKey,
          sourceRef: candidate.sourceRef,
          title: candidate.title,
          path: candidate.path,
          source: 'wiki',
          matchReason: candidate.matchReason,
          summary: candidate.summary,
          version: candidate.version,
          sourceHash: candidate.sourceHash,
          complete: false,
          derived: false,
          independentEvidence: true,
          kind: 'unknown',
          sourceRole: 'wiki',
          provenance: candidate.provenance,
          referenceDetails: candidate.referenceDetails,
          fieldCoverage: {
            requiredFields: candidate.requiredFields || [],
            matchedFields: candidate.matchedFields || [],
            unmatchedFields: candidate.unmatchedFields || [],
            fieldCoverageComplete: Boolean(candidate.fieldCoverageComplete)
          }
        }))
      }
    }

    if (scope === 'chain') {
      const matches = flattenChain(chain)
        .map(node => ({ node, matchReason: findMatchReason(q, node.searchableText) }))
        .filter(item => item.matchReason)
        .slice(0, MAX_CANDIDATES)
      return statusResult(matches.length ? 'ok' : 'no_results', {
        candidates: matches.map(({ node, matchReason }) => makeCandidate({
          roomKey,
          sourceRef: { type: 'map_node', roomId: roomKey, uid: node.uid, scope: 'chain' },
          title: node.title,
          path: node.path,
          source: 'chain',
          matchReason,
          summary: excerptFor(q, node.searchableText),
          version: chain && chain.version,
          kind: classifyCandidateKind({ title: node.title, path: node.path, content: node.searchableText, sourceRef: { type: 'map_node' } })
        })),
        complete: true
      })
    }

    if (scope === 'map_knowledge') {
      if (!db) return statusResult('unavailable', { error: 'map_search_unavailable', candidates: [], complete: false })
      const terms = queryTerms(q)
      const searches = terms.length ? terms.slice(0, 5) : [q]
      const byUid = new Map()
      try {
        for (const term of searches) {
          const result = await nodeSearch(db, roomKey, term, { limit: 100 })
          const matches = Array.isArray(result) ? result : result && result.matches || []
          const excludedUids = new Set([
            ...(Array.isArray(chain && chain.nodeUids) ? chain.nodeUids : []),
            ...(Array.isArray(chain && chain.excludeUids) ? chain.excludeUids : [])
          ].map(String))
          matches.forEach(match => {
            if (match && match.uid && !excludedUids.has(String(match.uid)) && !byUid.has(String(match.uid))) {
              byUid.set(String(match.uid), match)
            }
          })
          if (byUid.size >= MAX_CANDIDATES) break
        }
        const candidates = [...byUid.values()].slice(0, MAX_CANDIDATES).map(match => {
          const text = cleanText([match.text, match.note].filter(Boolean).join(' '))
          return makeCandidate({
            roomKey,
            sourceRef: { type: 'map_node', roomId: roomKey, uid: String(match.uid), scope: 'map_knowledge' },
            title: match.text || match.note || match.uid,
            path: match.path || [match.parent_uid, match.uid].filter(Boolean),
            source: 'map_knowledge',
            matchReason: findMatchReason(q, text) || `节点文本/备注匹配检索词：${searches.join('、')}`,
            summary: excerptFor(q, text),
            version: match.version || null,
            kind: classifyCandidateKind({ title: match.text || '', path: match.path || '', content: text, sourceRef: { type: 'map_node' } })
          })
        })
        return statusResult(candidates.length ? 'ok' : 'no_results', {
          candidates,
          complete: byUid.size < MAX_CANDIDATES
        })
      } catch (error) {
        return statusResult('unavailable', { error: 'map_search_failed', candidates: [], complete: false })
      }
    }

    if (scope !== 'company_ai') {
      return statusResult('error', { error: 'invalid_scope', candidates: [] })
    }
    if (!actorId(actor)) return statusResult('forbidden', { error: 'missing_user_identity', candidates: [], complete: false })

    const outcomes = await Promise.all([
      knowledgeCall(actor, 'canonical_list', { roomId: roomKey }),
      knowledgeCall(actor, 'docmost_search', { roomId: roomKey, query: q }),
      knowledgeCall(actor, 'openwiki_search', { roomId: roomKey, query: q })
    ])
    const candidates = []
    const errors = outcomes.filter(result => result.status !== 'ok')
    let canonicalDocsTotal = 0

    // canonical_list is ACL-gated. Since it has no text-search method, read at
    // most MAX_CANONICAL_DOCS bodies from this room and search only in memory.
    const canonicalList = outcomes[0]
    if (canonicalList.status === 'ok') {
      const items = Array.isArray(canonicalList.value)
        ? canonicalList.value
        : canonicalList.value && (canonicalList.value.items || canonicalList.value.results) || []
      const docs = items.filter(item => {
        const uri = String(item && item.uri || '')
        return item && item.roomId === roomKey && uri.startsWith(`canonical://room/${roomKey}/`)
      })
      canonicalDocsTotal = docs.length
      const docsToRead = docs.slice(0, MAX_CANONICAL_DOCS)
      const canonicalMatches = await mapLimit(docsToRead, 4, async item => {
        const sourceRef = canonicalRefFromItem(item, roomKey)
        if (!sourceRef) return null
        const read = await knowledgeCall(actor, 'canonical_read', { roomId: roomKey, path: sourceRef.path })
        if (read.status !== 'ok') return null
        const data = unwrapValue(read.value)
        const body = String(data && (data.body || data.content) || '')
        const displayTitle = await canonicalDisplayTitle({
          roomKey, db, path: sourceRef.path, body,
          titles: [data && data.title, item.title]
        })
        const reason = findMatchReason(q, `${displayTitle} ${body}`)
        if (!reason) return null
        const sourceComplete = body.length > 0 && body.length < Number(env.KNOWLEDGE_MCP_MAX_BODY || 200000) && !data.truncated
        const authority = sourceAuthority(data, 'canonical')
        return makeCandidate({
          roomKey,
          sourceRef,
          title: displayTitle,
          path: sourceRef.path,
          source: 'canonical',
          matchReason: reason,
          summary: excerptFor(q, body || displayTitle || sourceRef.path),
          // Search and later full reads both use canonical_read metadata. Do not
          // fall back to canonical_list's potentially stale version value.
          version: `${data.version || data.updatedAt || ''}:${sha256(body)}`,
          sourceHash: sha256(body),
          complete: sourceComplete,
          derived: authority.derived,
          independentEvidence: authority.independentEvidence,
          kind: sourceComplete ? classifyCandidateKind({ title: displayTitle, path: sourceRef.path, content: body, sourceRef }) : 'unknown',
          sourceRole: authority.derived ? 'derived' : 'canonical'
        })
      })
      candidates.push(...canonicalMatches.filter(Boolean))
    }

    const docmostSearch = outcomes[1]
    if (docmostSearch.status === 'ok') {
      const items = Array.isArray(docmostSearch.value)
        ? docmostSearch.value
        : docmostSearch.value && (docmostSearch.value.items || docmostSearch.value.results) || []
      for (const item of items.slice(0, MAX_CANDIDATES)) {
        if (!item || String(item.roomId || '') !== roomKey) continue
        const sourceRef = docmostRefFromItem(item, roomKey)
        if (!sourceRef) continue
        const read = await knowledgeCall(actor, 'docmost_get', {
          roomId: roomKey,
          topicKey: sourceRef.topicKey,
          slot: sourceRef.slot
        })
        if (read.status !== 'ok') continue
        const data = unwrapValue(read.value)
        if (data && data.status === 'not_created') continue
        const result = data && data.result || data
        const body = String(result && (result.body || result.content || result.snippet) || '')
        const reason = findMatchReason(q, `${result.title || item.title || ''} ${body}`)
        if (!reason) continue
        const authority = sourceAuthority({ ...item, ...result }, 'docmost')
        const derived = authority.derived
        const sourceComplete = body.length > 0 && body.length < Number(env.KNOWLEDGE_WIKI_MAX_BODY || 120000) && Boolean(result.body || result.content) && !result.truncated
        candidates.push(makeCandidate({
          roomKey,
          sourceRef,
          title: result.title || item.title,
          path: `${sourceRef.topicKey}/${sourceRef.slot}`,
          source: 'docmost',
          matchReason: reason,
          summary: excerptFor(q, body || result.title || item.title),
          version: `${result.version || item.version || ''}:${sha256(body)}`,
          sourceHash: sha256(body),
          complete: sourceComplete,
          derived,
          independentEvidence: authority.independentEvidence,
          kind: sourceComplete ? classifyCandidateKind({ title: result.title || item.title, path: `${sourceRef.topicKey}/${sourceRef.slot}`, content: body, sourceRef }) : 'unknown',
          sourceRole: derived ? 'derived' : 'mapped_docmost'
        }))
      }
    }

    const openwikiSearch = outcomes[2]
    if (openwikiSearch.status === 'ok') {
      const items = Array.isArray(openwikiSearch.value)
        ? openwikiSearch.value
        : openwikiSearch.value && (openwikiSearch.value.items || openwikiSearch.value.results) || []
      for (const item of items.slice(0, MAX_CANDIDATES)) {
        const sourceRef = openwikiRefFromItem(item, roomKey)
        if (!sourceRef) continue
        const summary = String(item.snippet || '')
        const reason = findMatchReason(q, `${item.title || ''} ${sourceRef.path} ${summary}`)
        if (!reason) continue
        candidates.push(makeCandidate({
          roomKey,
          sourceRef,
          title: item.title,
          path: sourceRef.path,
          source: 'openwiki',
          matchReason: reason,
          summary: excerptFor(q, summary || item.title),
          version: item.updatedAt || null,
          sourceHash: summary ? sha256(summary) : null,
          complete: false,
          kind: 'unknown',
          sourceRole: 'derived',
          derived: true,
          independentEvidence: false
        }))
      }
    }

    const unique = [...new Map(candidates.map(candidate => [candidate.candidateId, candidate])).values()]
      .slice(0, MAX_CANDIDATES)
    const complete = errors.length === 0 && canonicalDocsTotal <= MAX_CANONICAL_DOCS
    if (unique.length) return statusResult('ok', { candidates: unique, complete, errors: errors.map(item => item.error || item.status) })
    if (errors.length) {
      const status = errors.some(item => item.status === 'forbidden') ? 'forbidden' : 'unavailable'
      return statusResult(status, { candidates: [], complete: false, errors: errors.map(item => item.error || item.status) })
    }
    return statusResult('no_results', { candidates: [], complete, errors: [] })
  }

  async function readSource({ roomKey, sourceRef, actor, mode = 'business', requestCache } = {}) {
    if (signal && signal.aborted) return statusResult('unavailable', { sourceRef: sourceRef || null, error: 'request_aborted', complete: false, truncated: false })
    if (!safeRoomKey(roomKey) || !sourceRef || typeof sourceRef !== 'object') {
      return statusResult('error', { sourceRef: sourceRef || null, error: 'invalid_source_ref', complete: false, truncated: false })
    }
    if (String(sourceRef.roomId || sourceRef.roomKey || '') !== roomKey) {
      return statusResult('forbidden', { sourceRef, error: 'cross_room_source_ref', complete: false, truncated: false })
    }
    if (!actorId(actor)) return statusResult('forbidden', { sourceRef, error: 'missing_user_identity', complete: false, truncated: false })

    if (sourceRef.type === 'wiki_compiler') {
      return wiki.readSource({ roomKey, sourceRef, mode, actor, requestCache })
    }

    if (sourceRef.type === 'chain_node') {
      if (!db) return statusResult('unavailable', { sourceRef, error: 'map_read_unavailable', complete: false, truncated: false })
      const uid = String(sourceRef.nodeUid || sourceRef.uid || '')
      if (!uid || uid.length > 200) return statusResult('error', { sourceRef, error: 'invalid_source_ref', complete: false, truncated: false })
      try {
        const result = await db.query(
          `select uid, data, node_version from room_nodes where room_key=$1 and uid=$2 and deleted_at is null limit 1`,
          [roomKey, uid]
        )
        const row = result.rows && result.rows[0]
        if (!row) return statusResult('no_results', { sourceRef, error: 'source_node_missing', complete: false, truncated: false })
        const data = typeof row.data === 'string' ? parseJsonText(row.data) || {} : row.data || {}
        const node = { ...row, data }
        const title = chainUtils.nodeText(node)
        const note = chainUtils.nodeNote(node)
        const content = `${title}\n${note}\n${JSON.stringify(data)}`
        const version = sha256(content)
        return statusResult('ok', {
          sourceRef,
          title,
          content,
          version,
          sourceHash: sha256(content),
          complete: Boolean(content),
          truncated: false,
          provenance: { origin: 'business', sourceTitle: '当前脑图', sourceId: roomKey },
          sourceRole: 'current_chain'
        })
      } catch {
        return statusResult('unavailable', { sourceRef, error: 'map_read_failed', complete: false, truncated: false })
      }
    }

    if (sourceRef.type === 'map_node') {
      if (!db) return statusResult('unavailable', { sourceRef, error: 'map_read_unavailable', complete: false, truncated: false })
      const uid = String(sourceRef.uid || '')
      if (!uid || uid.length > 200) return statusResult('error', { sourceRef, error: 'invalid_source_ref', complete: false, truncated: false })
      try {
        const result = await readMapSubtree(db, roomKey, uid)
        return statusResult(result.status, { sourceRef, ...result })
      } catch {
        return statusResult('unavailable', { sourceRef, error: 'map_read_failed', complete: false, truncated: false })
      }
    }

    let toolName
    let args
    if (sourceRef.type === 'canonical' && sourceRef.path) {
      toolName = 'canonical_read'
      args = { roomId: roomKey, path: sourceRef.path }
    } else if (sourceRef.type === 'docmost' && sourceRef.topicKey && sourceRef.slot) {
      toolName = 'docmost_get'
      args = { roomId: roomKey, topicKey: sourceRef.topicKey, slot: sourceRef.slot }
    } else if (sourceRef.type === 'openwiki' && sourceRef.path) {
      toolName = 'openwiki_read'
      args = { roomId: roomKey, path: sourceRef.path }
    } else {
      return statusResult('error', { sourceRef, error: 'invalid_source_ref', complete: false, truncated: false })
    }

    const read = await knowledgeCall(actor, toolName, args)
    if (read.status !== 'ok') {
      return statusResult(read.status, { sourceRef, error: read.error || 'source_read_failed', complete: false, truncated: false })
    }
    const data = unwrapValue(read.value)
    const result = data && data.result || data
    if (!result || data.status === 'not_created' || data.status === 'not_generated') {
      return statusResult('no_results', { sourceRef, error: data.status, complete: false, truncated: false })
    }
    const content = String(result.body || result.content || '')
    const configuredLimit = sourceRef.type === 'canonical'
      ? Number(env.KNOWLEDGE_MCP_MAX_BODY || 200000)
      : Number(env.KNOWLEDGE_WIKI_MAX_BODY || 120000)
    const truncated = Boolean(result.truncated || (configuredLimit > 0 && content.length >= configuredLimit))
    return statusResult('ok', {
      sourceRef,
      version: `${result.version || result.updatedAt || ''}:${sha256(content)}`,
      sourceHash: sha256(content),
      content,
      complete: !truncated && Boolean(content),
      truncated,
      ...sourceAuthority(result, sourceRef.type),
      kind: !truncated && content ? classifyCandidateKind({ title: result.title || '', path: sourceRef.path || '', content, sourceRef }) : 'unknown',
      sourceRole: sourceAuthority(result, sourceRef.type).derived
        ? 'derived'
        : sourceRef.type === 'canonical' ? 'canonical' : sourceRef.type === 'docmost' ? 'mapped_docmost' : 'derived',
      error: content ? undefined : 'source_body_missing'
    })
  }

  return { searchSources, readSource }
}

function unwrapValue(value) {
  if (value && value.value !== undefined) return value.value
  return value
}

function canonicalRefFromItem(item, roomKey) {
  const uri = String(item && item.uri || '')
  const prefix = `canonical://room/${roomKey}/`
  if (!uri.startsWith(prefix)) return null
  let relPath = uri.slice(prefix.length)
  try { relPath = relPath.split('/').map(segment => decodeURIComponent(segment)).join('/') } catch {}
  if (!relPath || relPath.startsWith('../') || relPath.includes('\\') || relPath.split('/').includes('..')) return null
  return { type: 'canonical', roomId: roomKey, path: relPath }
}

function looksLikeOpaqueTitle(value) {
  const title = String(value || '').trim().replace(/^#+\s*/, '')
  return !title || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(title) ||
    /^(?:branches\/)?[0-9a-f]{8}-[0-9a-f-]{27,}(?:\.md)?$/i.test(title)
}

function markdownTitle(body) {
  const lines = String(body || '').split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^\s*#\s+(.+?)\s*#*\s*$/)
    if (match && !looksLikeOpaqueTitle(match[1])) return cleanText(match[1], 160)
  }
  return ''
}

async function canonicalNodeTitle(db, roomKey, sourcePath) {
  const match = String(sourcePath || '').match(/(?:^|\/)branches\/([0-9a-f-]{36})\.md$/i)
  if (!db || !match) return ''
  try {
    const result = await db.query(
      `select data from room_nodes where room_key=$1 and uid=$2 and deleted_at is null limit 1`,
      [roomKey, match[1]]
    )
    const row = result.rows && result.rows[0]
    const data = row && (typeof row.data === 'string' ? parseJsonText(row.data) : row.data)
    const title = data && cleanNodeText(data.text || data.title || '', 160)
    return title && !looksLikeOpaqueTitle(title) ? title.replace(/^(?:[CPD]\s*[:：]\s*)/i, '') : ''
  } catch {
    return ''
  }
}

async function canonicalDisplayTitle({ roomKey, db, path: sourcePath, body, titles = [] } = {}) {
  for (const value of titles) {
    if (!looksLikeOpaqueTitle(value)) return cleanText(value, 160)
  }
  const heading = markdownTitle(body)
  if (heading) return heading
  const nodeTitle = await canonicalNodeTitle(db, roomKey, sourcePath)
  if (nodeTitle) return nodeTitle
  const leaf = String(sourcePath || '').split('/').pop().replace(/\.md$/i, '')
  return looksLikeOpaqueTitle(leaf) ? '未命名资料' : cleanText(leaf, 160)
}

function docmostRefFromItem(item, roomKey) {
  const topicKey = String(item.topicKey || '').trim()
  const slot = String(item.pageType || item.slot || '').trim()
  if (!topicKey || topicKey.length > 200 || !slot || !/^(standard|ai|human|[a-z0-9_-]+)$/i.test(slot)) return null
  return { type: 'docmost', roomId: roomKey, topicKey, slot }
}

function openwikiRefFromItem(item, roomKey) {
  const uri = String(item && item.uri || '')
  const prefix = `openwiki://room/${roomKey}/`
  if (!uri.startsWith(prefix)) return null
  let relPath = uri.slice(prefix.length)
  try { relPath = relPath.split('/').map(segment => decodeURIComponent(segment)).join('/') } catch {}
  if (!relPath || relPath.startsWith('../') || relPath.includes('\\') || relPath.split('/').includes('..')) return null
  return { type: 'openwiki', roomId: roomKey, path: relPath }
}

async function mapLimit(items, concurrency, mapper) {
  const input = Array.isArray(items) ? items : []
  const output = new Array(input.length)
  let cursor = 0
  const count = Math.min(input.length, Math.max(1, concurrency))
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < input.length) {
      const index = cursor++
      output[index] = await mapper(input[index], index)
    }
  }))
  return output
}

async function readMapSubtree(db, roomKey, uid) {
  const first = await db.query(
    `select uid, parent_uid, position, data, node_version
       from room_nodes where room_key=$1 and uid=$2 and deleted_at is null limit 1`,
    [roomKey, uid]
  )
  if (!first.rows || !first.rows.length) return { status: 'no_results', complete: false, truncated: false, error: 'source_node_missing' }
  const root = first.rows[0]
  const rows = [root]
  let frontier = [String(root.uid)]
  let depth = 0
  let truncated = false

  while (frontier.length && rows.length < MAX_READ_NODES && depth < MAX_READ_DEPTH) {
    const children = await db.query(
      `select uid, parent_uid, position, data, node_version
         from room_nodes
        where room_key=$1 and parent_uid = any($2::text[]) and deleted_at is null
        order by parent_uid, position, uid
        limit $3`,
      [roomKey, frontier, Math.min(MAX_READ_NODES - rows.length + 1, 100)]
    )
    const next = children.rows || []
    if (!next.length) break
    if (rows.length + next.length > MAX_READ_NODES) {
      rows.push(...next.slice(0, MAX_READ_NODES - rows.length))
      truncated = true
      break
    }
    rows.push(...next)
    frontier = next.map(row => String(row.uid))
    depth += 1
  }
  if (frontier.length && depth >= MAX_READ_DEPTH) truncated = true

  const attachmentIds = new Set()
  const rowData = new Map()
  rows.forEach(row => {
    const data = typeof row.data === 'string' ? parseJsonText(row.data) || {} : row.data || {}
    rowData.set(String(row.uid), data)
    if (data.attachmentId) attachmentIds.add(String(data.attachmentId))
    for (const attachment of Array.isArray(data.attachments) ? data.attachments : []) {
      if (attachment && (attachment.id || attachment.attachmentId)) {
        attachmentIds.add(String(attachment.id || attachment.attachmentId))
      }
    }
  })

  let attachmentRows = []
  let attachmentListTruncated = false
  try {
    const result = await db.query(
      `with matched as (
         select id, room_key, node_uid, file_name, content_hash, status, error_message, updated_at,
                char_length(extracted_text) as total_chars,
                coalesce(sum(char_length(extracted_text)) over (
                  order by id rows between unbounded preceding and 1 preceding
                ), 0) as used_chars
           from node_attachments
          where room_key=$1 and (node_uid = any($2::text[]) or id = any($3::text[]))
          order by id limit ${MAX_READ_ATTACHMENTS + 1}
       )
       select matched.id, matched.node_uid, matched.file_name, matched.content_hash,
              matched.status, matched.error_message, matched.updated_at, matched.total_chars,
              case when matched.used_chars < ${MAX_SOURCE_CHARS + 1}
                then substr(a.extracted_text, 1, least(200001, ${MAX_SOURCE_CHARS + 1} - matched.used_chars)::integer)
                else '' end as content
         from matched join node_attachments a using (room_key, id)
        order by matched.id`,
      [roomKey, rows.map(row => String(row.uid)), [...attachmentIds]]
    )
    attachmentRows = result.rows || []
    if (attachmentRows.length > MAX_READ_ATTACHMENTS) {
      attachmentRows = attachmentRows.slice(0, MAX_READ_ATTACHMENTS)
      attachmentListTruncated = true
    }
  } catch (error) {
    // Missing attachment table or an ACL/database failure must never be reported
    // as a complete source. Startup migration normally guarantees the table.
    const content = rows.map(row => {
      const data = rowData.get(String(row.uid)) || {}
      return [cleanNodeText(data.text || ''), cleanNoteText(data.note || '')].filter(Boolean).join('\n')
    }).filter(Boolean).join('\n')
    const sourceHash = sha256(rows.map(row => `${row.uid}:${row.node_version || 0}:${JSON.stringify(row.data || {})}`).join('\n'))
    return {
      status: 'ok',
      version: `${rows.reduce((max, row) => Math.max(max, Number(row.node_version) || 0), 0)}:${sourceHash}`,
      sourceHash,
      content,
      complete: false,
      truncated: false,
      error: 'attachment_read_failed',
      nodeCount: rows.length
    }
  }

  const depthByUid = new Map([[String(root.uid), 0]])
  const parts = []
  let renderedChars = 0
  const append = line => {
    const text = String(line || '')
    if (renderedChars >= MAX_SOURCE_CHARS) {
      truncated = true
      return
    }
    const remaining = MAX_SOURCE_CHARS - renderedChars
    const clipped = text.slice(0, remaining)
    parts.push(clipped)
    renderedChars += clipped.length + 1
    if (clipped.length < text.length) truncated = true
  }
  rows.forEach(row => {
    const uid = String(row.uid)
    const data = rowData.get(uid) || {}
    const parentUid = String(row.parent_uid || '')
    const level = depthByUid.has(parentUid) ? depthByUid.get(parentUid) + 1 : 0
    depthByUid.set(uid, level)
    const title = cleanNodeText(data.text || data.title || '')
    const note = cleanNoteText(data.note || '')
    append(`${'  '.repeat(Math.min(24, level))}- [${uid}] ${title || '(无标题)'}`)
    if (note) append(`${'  '.repeat(Math.min(24, level + 1))}备注：${note}`)
    const attachedForNode = attachmentRows.filter(att =>
      String(att.node_uid || '') === uid || attachmentIds.has(String(att.id || '')) && (
        String(data.attachmentId || '') === String(att.id || '') ||
        (Array.isArray(data.attachments) && data.attachments.some(item => String(item && (item.id || item.attachmentId) || '') === String(att.id || '')))
      )
    )
    if ((data.attachmentName || data.attachmentUrl || data.attachmentExtractedText) && !attachedForNode.length) {
      append(`${'  '.repeat(Math.min(24, level + 1))}附件引用：${cleanText(data.attachmentName || '外部附件')}（完整正文未读取；节点预览不作为完整证据）`)
    }
    attachedForNode.forEach(att => {
      const fileName = cleanText(att.file_name || att.id || '附件', 180)
      if (att.status !== 'ready') {
        append(`${'  '.repeat(Math.min(24, level + 1))}附件《${fileName}》状态 ${cleanText(att.status || 'unknown')}：${cleanText(att.error_message || '未就绪')}`)
        return
      }
      const totalChars = Number(att.total_chars || 0)
      const text = String(att.content || '')
      append(`${'  '.repeat(Math.min(24, level + 1))}附件《${fileName}》：`)
      append(text.slice(0, Math.min(200000, MAX_SOURCE_CHARS)))
      if (totalChars > text.length || totalChars > 200000) truncated = true
    })
  })
  if (attachmentListTruncated) append('附件列表超过单次读取上限，来源不完整。')

  const content = parts.join('\n')
  const missingAttachments = rows.some(row => {
    const data = rowData.get(String(row.uid)) || {}
    const hasAttachment = Boolean(data.attachmentId || data.attachmentUrl || data.attachmentName || data.attachmentExtractedText || (Array.isArray(data.attachments) && data.attachments.length))
    if (!hasAttachment) return false
    const ids = new Set([
      data.attachmentId,
      ...(Array.isArray(data.attachments) ? data.attachments.map(item => item && (item.id || item.attachmentId)) : [])
    ].filter(Boolean).map(String))
    if (ids.size) {
      return [...ids].some(id => !attachmentRows.some(att => String(att.id || '') === id))
    }
    return !attachmentRows.some(att => String(att.node_uid || '') === String(row.uid))
  })
  const nonReadyAttachments = attachmentRows.some(att => att.status !== 'ready')
  const emptyReadyAttachments = attachmentRows.some(att =>
    att.status === 'ready' && (Number(att.total_chars || 0) <= 0 || String(att.content || '').length === 0)
  )
  const attachmentTextTruncated = attachmentRows.some(att => Number(att.total_chars || 0) > String(att.content || '').length)
  const unresolvedAttachments = attachmentListTruncated || missingAttachments || nonReadyAttachments || emptyReadyAttachments || attachmentTextTruncated
  const version = rows.reduce((max, row) => Math.max(max, Number(row.node_version) || 0), 0)
  const hash = crypto.createHash('sha256')
  rows.forEach(row => {
    hash.update(String(row.uid || ''))
    hash.update('\0')
    hash.update(String(row.parent_uid || ''))
    hash.update('\0')
    hash.update(JSON.stringify(row.data || {}))
    hash.update('\0')
  })
  attachmentRows.forEach(att => {
    hash.update(`${att.id || ''}:${att.content_hash || ''}:${att.status || ''}:${att.updated_at || ''}:${att.total_chars || 0}:${sha256(att.content || '')}`)
    hash.update('\0')
  })
  hash.update(content)
  const contentHash = hash.digest('hex')
  return {
    status: content ? 'ok' : 'no_results',
    version: `${version}:${contentHash}`,
    sourceHash: contentHash,
    content,
    complete: Boolean(content) && !truncated && !unresolvedAttachments,
    truncated: Boolean(truncated || attachmentListTruncated || attachmentTextTruncated),
    kind: classifyCandidateKind({ title: cleanText(rowData.get(String(root.uid)) && rowData.get(String(root.uid)).text || ''), content, sourceRef: { type: 'map_node' } }),
    sourceRole: 'room_map',
    error: attachmentListTruncated ? 'attachment_limit_reached'
      : missingAttachments ? 'attachment_record_missing'
        : nonReadyAttachments ? 'attachments_not_ready'
          : emptyReadyAttachments ? 'attachment_text_missing'
            : attachmentTextTruncated || truncated ? 'source_truncated' : undefined,
    nodeCount: rows.length
  }
}

module.exports = {
  createCheckProviders,
  flattenChain,
  findMatchReason,
  canonicalDisplayTitle,
  sourceIdFor,
  MCP_READ_TOOLS
}
