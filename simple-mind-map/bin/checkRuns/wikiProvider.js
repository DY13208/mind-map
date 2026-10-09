const { issueIdentity } = require('../wikiCompiler/access')
'use strict'

const crypto = require('crypto')
const { sourceIdFor } = require('./identity')

const MAX_QUERY_CHARS = 240
const MAX_RESULTS = 30
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_SOURCE_CHARS = 200000
const DEFAULT_BASE_URL = 'http://wiki-graph:3848'
const REQUEST_CACHE_TTL_MS = 30000
const FIELD_QUERY_TERMS = {
  frequency: ['频率', '周期', '时间要求'],
  input: ['输入源', '输入', '数据源', '依赖资料'],
  criterion: ['判据', '检查标准', '验收标准', '完成标准', '达标条件'],
  owner: ['责任人', '负责人', '执行人'],
  artifact: ['产物', '输出', '交付物']
}
const FIELD_LABELS = {
  frequency: '频率', input: '输入源', criterion: '判据', owner: '责任人', artifact: '产物'
}
const BUSINESS_CONTEXT_STOP_TERMS = [
  '未达标处置', '检查标准', '验收标准', '完成标准', '达标条件', '材料来源', '依赖资料',
  '目标值', '输入源', '数据源', '时间要求', '执行步骤', '检查项',
  '每个工作日', '每季度', '每星期', '每小时', '每周', '每月', '每年', '每日', '每天', '每次',
  '不得低于', '不低于', '不少于', '不超过', '不高于',
  '第一套', '第二套', '第三套', '第四套', '检查目标', '候选', '确认', '对应', '验收',
  '责任人', '负责人', '执行人', '频率', '周期', '判据', '目标', '检查', '计划', '执行',
  '流程', '方案', '步骤', '方法', '内容', '要求', '记录', '来源', '输入', '输出', '产物',
  '交付物', '材料', '数据', '操作', '处理', '进行', '达到', '达标', '确保', '使用', '按照',
  '至少', '至多', '不低', '根据', '开展', '跟踪', '持续', '并', '按', '本次', '当前', '相关',
  '是否', '可以', '需要', '必须', '以及', '并且',
  'sop', 'cpd'
].sort((left, right) => right.length - left.length)
const MAX_BUSINESS_CONTEXT_TEXTS = 32
const MAX_BUSINESS_CONTEXT_TEXT_CHARS = 500
const MAX_BUSINESS_TERMS = 120
const MAX_RELEVANCE_TEXT_CHARS = 50000

function result(status, extra = {}) {
  return { status, ...extra }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}

function cleanText(value, max = 200000) {
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

function abortLink(signal, timeoutMs) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal && signal.reason)
  if (signal && signal.aborted) onAbort()
  else if (signal) signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
}

function configuredBaseUrl(env) {
  const explicit = Object.prototype.hasOwnProperty.call(env, 'CPD_WIKI_API_URL')
  const raw = explicit ? String(env.CPD_WIKI_API_URL || '').trim() : DEFAULT_BASE_URL
  if (!raw) return { error: 'wiki_not_configured' }
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return { error: 'wiki_url_invalid' }
    }
    url.pathname = url.pathname.replace(/\/+$/, '')
    return { url }
  } catch {
    return { error: 'wiki_url_invalid' }
  }
}

function endpointUrl(base, endpoint) {
  const root = base.pathname.replace(/\/+$/, '')
  const url = new URL(base.toString())
  url.pathname = `${root}/api/${endpoint}`.replace(/\/{2,}/g, '/')
  return url
}

function makeTopicUrl(base, topic) {
  return endpointUrl(base, `topic/${encodeURIComponent(topic)}`)
}

async function readLimited(response) {
  const declared = Number(response.headers && response.headers.get && response.headers.get('content-length'))
  if (declared > MAX_RESPONSE_BYTES) throw Object.assign(new Error('wiki_response_too_large'), { code: 'wiki_response_too_large' })
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {})
          throw Object.assign(new Error('wiki_response_too_large'), { code: 'wiki_response_too_large' })
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      if (reader.releaseLock) reader.releaseLock()
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error('wiki_response_too_large'), { code: 'wiki_response_too_large' })
  }
  return body
}

function responseStatus(response, operation) {
  if (response.status === 401 || response.status === 403) return result('forbidden', { error: 'wiki_forbidden' })
  if (operation === 'topic' && response.status === 404) return result('no_results', { error: 'wiki_topic_not_found' })
  if (response.status >= 500 || response.status === 429) return result('unavailable', { error: `wiki_http_${response.status}` })
  return result('parse_failed', { error: `wiki_http_${response.status}` })
}

function parseTopicName(value) {
  const name = String(value || '').trim()
  if (!name || name.length > 240 || name === '.' || name === '..' || /[\\/\0]/.test(name)) return ''
  return name
}

function normalizeProvenance(value) {
  const input = value && typeof value === 'object' ? value : {}
  const origin = ['business', 'demo'].includes(String(input.origin || '').toLowerCase())
    ? String(input.origin).toLowerCase()
    : 'unknown'
  return {
    origin,
    sourceTitle: typeof input.sourceTitle === 'string' ? input.sourceTitle.trim().slice(0, 240) : '',
    sourceId: typeof input.sourceId === 'string' ? input.sourceId.trim().slice(0, 240) : ''
  }
}

function cacheRead(cache, key) {
  if (!(cache instanceof Map)) return null
  const entry = cache.get(key)
  if (!entry) return null
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  return entry.value
}

function cacheWrite(cache, key, value) {
  if (!(cache instanceof Map)) return
  cache.set(key, { value, expiresAt: Date.now() + REQUEST_CACHE_TTL_MS })
}

function cacheDelete(cache, key) {
  if (cache instanceof Map) cache.delete(key)
}

function referenceDetailsFor(items, { complete = false, allSections = null } = {}) {
  const sections = Array.isArray(allSections)
    ? allSections.filter(section => section && typeof section.heading === 'string' && typeof section.content === 'string')
    : (Array.isArray(items) ? items : []).map(item => ({ heading: item.section, content: item.content }))
  const groups = { C: [], P: [], D: [] }
  const fields = { frequency: [], input: [], criterion: [], owner: [], artifact: [] }
  const patterns = {
    frequency: /频率|周期|每(?:日|天|周|月|季度|年)|每隔/i,
    input: /输入|数据源|來源|来源|系统|清单|工具/i,
    criterion: /判据|验收|达标|标准|不低于|至少|不得低于|达到/i,
    owner: /责任人|负责人|责任岗位|执行人|审核人/i,
    artifact: /产物|输出|报表|报告|记录|台账/i
  }
  for (const section of sections) {
    const heading = normalizeHeading(section.heading)
    if (/^sources$/i.test(heading)) continue
    const roleMatch = heading.match(/^(?:([CPD])\s*(?:[:：]|$)|(?:检查|目标|计划|执行|动作)\s*(?:[:：]|$))/i)
    const role = roleMatch && (roleMatch[1] || (/^(?:检查|目标)/.test(heading) ? 'C' : /^(?:计划)/.test(heading) ? 'P' : 'D'))
    const lines = String(section.content || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const roleLines = { C: [], P: [], D: [] }
    for (const line of lines) {
      const lineRole = line.match(/^(?:[-*]\s*)?([CPD])\s*[:：]/i)
      if (lineRole) roleLines[lineRole[1].toUpperCase()].push(line)
    }
    if (role) groups[role].push({ heading, text: String(section.content || '').trim() })
    else {
      for (const letter of ['C', 'P', 'D']) {
        if (roleLines[letter].length) groups[letter].push({ heading, text: roleLines[letter].join('\n') })
      }
    }
    for (const rawLine of lines) {
      const line = rawLine.split(/\s*[；;]\s*/).filter(Boolean)
      const entries = line.length > 1 ? line : [rawLine]
      for (const entry of entries) {
        for (const [field, pattern] of Object.entries(patterns)) {
          if (pattern.test(entry) && !fields[field].includes(entry)) fields[field].push(entry)
        }
      }
    }
  }
  const matchedTerms = [...new Set((Array.isArray(items) ? items : []).flatMap(item => item.matchedTerms || []))].slice(0, 20)
  return { complete: Boolean(complete), C: groups.C, P: groups.P, D: groups.D, fields, matchedTerms }
}

function normalizeSearchItem(item) {
  if (!item || typeof item !== 'object') return null
  const topic = parseTopicName(item.topic)
  const section = typeof item.section === 'string' ? item.section.trim() : ''
  const chunkId = typeof item.chunk_id === 'string' ? item.chunk_id.trim() : ''
  const content = typeof item.content === 'string' ? item.content : ''
  if (!topic || !section || !chunkId || !content) return null
  if (!chunkId.startsWith(`${topic}::${section}::`)) return null
  const version = item.version == null ? '' : String(item.version)
  const sourcePaths = Array.isArray(item.source)
    ? item.source.filter(value => typeof value === 'string' && value.trim()).slice(0, 30).map(value => value.slice(0, 1000))
    : []
  return {
    topic, title: String(item.topic_title || topic), section, chunkId, content, version, sourcePaths, score: Number(item.score),
    matchedTerms: Array.isArray(item.matched_terms)
      ? [...new Set(item.matched_terms.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 80)))].slice(0, 30)
      : [],
    provenance: normalizeProvenance(item.provenance)
  }
}

function pathFor(topic, section) {
  return `Wiki / ${topic} / ${section}`
}

function makeSourceRef(roomKey, query, items) {
  const list = Array.isArray(items) ? items : [items]
  const primary = [...list].sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0))[0]
  const matches = list.map(item => ({
    section: item.section,
    chunkId: item.chunkId,
    chunkHash: sha256(item.content),
    version: item.version || null
  }))
  return {
    type: 'wiki_compiler',
    roomId: roomKey,
    topic: primary.topic,
    sourceId: sourceIdFor({ type: 'wiki_compiler', roomId: roomKey, topic: primary.topic }),
    section: primary.section,
    chunkId: primary.chunkId,
    query,
    chunkHash: sha256(primary.content),
    version: primary.version || null,
    matches,
    sourcePaths: [...new Set(list.flatMap(item => item.sourcePaths || []))].slice(0, 30),
    provenance: normalizeProvenance(primary.provenance)
  }
}

function matchesOf(sourceRef) {
  if (Array.isArray(sourceRef.matches) && sourceRef.matches.length) return sourceRef.matches
  return [{ section: sourceRef.section, chunkId: sourceRef.chunkId, chunkHash: sourceRef.chunkHash, version: sourceRef.version }]
}

function matchIsCurrent(match, item) {
  return Boolean(item) && item.chunkId === match.chunkId && item.section === match.section &&
    Boolean(match.chunkHash) && sha256(item.content) === match.chunkHash &&
    String(match.version || '') === String(item.version || '')
}

function normalizeHeading(value) {
  return String(value || '').replace(/\s*\[coverage:[^\]]*\]\s*$/i, '').trim()
}

function sectionContent(topic, sectionName) {
  if (!Array.isArray(topic.sections)) return null
  const matching = topic.sections.filter(section =>
    section && typeof section.heading === 'string' && normalizeHeading(section.heading) === sectionName
  )
  if (matching.length !== 1 || typeof matching[0].content !== 'string') return null
  return matching[0].content
}

function renderTopic(topic) {
  const title = String(topic.title || topic.slug || topic.meta.topic || '').trim()
  const sections = topic.sections.map(section => `## ${section.heading}\n${section.content}`)
  return [`# ${title}`, ...sections].join('\n\n').trim()
}

function classifyTopic(content) {
  const normalized = String(content || '').split(/\r?\n/).map(line => line
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\*\*|__/g, '')
    .trim())
  const role = (letter, aliases) => normalized.some(line =>
    new RegExp(`^(?:${letter}\\s*(?:[:：]|$)|(?:${aliases})\\s*(?:[:：]|$))`, 'i').test(line)
  )
  return role('C', '检查|目标') && role('P', '计划') && role('D', '执行|动作') ? 'flow' : 'unknown'
}

function createWikiProvider({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 8000, signal } = {}) {
  async function requestJson(url, { method = 'GET', body, operation, requestCache, cacheKey, actor } = {}) {
    const configured = configuredBaseUrl(env)
    if (configured.error) return result('unavailable', { error: configured.error })
    if (typeof fetchImpl !== 'function') return result('unavailable', { error: 'wiki_fetch_unavailable' })
    if (cacheKey) {
      const cached = cacheRead(requestCache, cacheKey)
      if (cached) return result('ok', { value: cached, cached: true })
    }
    const linked = abortLink(signal, timeoutMs)
    try {
      const response = await fetchImpl(url.toString(), {
        method,
        headers: { 'X-Wiki-Compiler-Identity': issueIdentity(String(actor && (actor.id || actor.userId || actor.sub) || ''), env), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: linked.signal
      })
      if (!response.ok) return responseStatus(response, operation)
      let text
      try { text = await readLimited(response) } catch (error) {
        return result('parse_failed', { error: error.code || 'wiki_response_too_large' })
      }
      let data
      try { data = JSON.parse(text) } catch { return result('parse_failed', { error: 'wiki_invalid_json' }) }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return result('parse_failed', { error: 'wiki_invalid_response' })
      if (cacheKey) cacheWrite(requestCache, cacheKey, data)
      return result('ok', { value: data })
    } catch (error) {
      return result('unavailable', {
        error: signal && signal.aborted
          ? 'request_aborted'
          : error && error.name === 'AbortError' ? 'wiki_timeout' : 'wiki_unreachable'
      })
    } finally {
      linked.dispose()
    }
  }

  async function search(query, { roomKey = '', actor, mode = 'business', requestCache } = {}) {
    const configured = configuredBaseUrl(env)
    if (configured.error) return result('unavailable', { error: configured.error, candidates: [], complete: false })
    const cacheKey = `wiki-search:${configured.url.origin}:${roomKey}:${String(actor && (actor.id || actor.userId || actor.sub) || '')}:${mode}:${query}`
    const response = await requestJson(endpointUrl(configured.url, 'search'), {
      method: 'POST',
      body: { query, top_k: MAX_RESULTS, mode },
      operation: 'search',
      actor, requestCache,
      cacheKey
    })
    if (response.status !== 'ok') return { ...response, candidates: [], complete: false }
    const data = response.value
    if (!Array.isArray(data.results)) {
      cacheDelete(requestCache, cacheKey)
      return result('parse_failed', { error: 'wiki_invalid_search_response', candidates: [], complete: false })
    }
    const candidates = []
    for (const raw of data.results.slice(0, MAX_RESULTS)) {
      const item = normalizeSearchItem(raw)
      if (!item) {
        cacheDelete(requestCache, cacheKey)
        return result('parse_failed', { error: 'wiki_invalid_search_item', candidates: [], complete: false })
      }
      const sourceRef = makeSourceRef('', query, item)
      candidates.push({ item, sourceRef })
    }
    return result(candidates.length ? 'ok' : 'no_results', {
      candidates,
      complete: data.results.length < MAX_RESULTS,
      version: data.version == null ? null : String(data.version)
    })
  }

  async function searchSources({ roomKey, query, businessContext, mode = 'business', actor, requestCache } = {}) {
    const q = String(query || '').trim().slice(0, MAX_QUERY_CHARS)
    if (!roomKey || !['business', 'demo'].includes(mode)) return result('error', { error: 'invalid_room_or_query_or_mode', candidates: [], complete: false })
    const relevance = businessRelevanceTerms(businessContext, q)
    if (relevance.explicit && !relevance.terms.length) return result('no_results', {
      candidates: [], complete: true, filteredCount: 0, matchReason: noRelevantCandidatesReason(0)
    })
    if (!q && !relevance.explicit) return result('error', { error: 'invalid_room_or_query_or_mode', candidates: [], complete: false })
    const searchQuery = relevance.terms.join(' ').slice(0, MAX_QUERY_CHARS)
    if (!searchQuery) return result('no_results', {
      candidates: [], complete: true, filteredCount: 0, matchReason: noRelevantCandidatesReason(0)
    })
    const searched = await search(searchQuery, { roomKey, actor, mode, requestCache })
    if (searched.status !== 'ok' && searched.status !== 'no_results') return searched
    if (searched.status === 'no_results') return {
      ...searched,
      candidates: [],
      complete: true,
      filteredCount: 0,
      matchReason: noRelevantCandidatesReason(relevance.terms.length)
    }
    const byTopic = new Map()
    for (const { item } of searched.candidates) {
      // Enforce the default policy in the caller too. A client provided
      // provenance field is never used here; item.provenance came from Wiki.
      if (mode === 'business' && item.provenance.origin === 'demo') continue
      const group = byTopic.get(item.topic) || []
      group.push(item)
      byTopic.set(item.topic, group)
    }
    const candidates = []
    let filteredCount = 0
    for (const items of byTopic.values()) {
      const businessMatches = matchingBusinessTerms(relevance.terms, items)
      if (!businessMatches.length) {
        filteredCount += 1
        continue
      }
      const sourceRef = makeSourceRef(roomKey, searchQuery, items)
      const primary = items.find(item => item.chunkId === sourceRef.chunkId) || items[0]
      const sourceHash = sha256(primary.content)
      const referenceDetails = referenceDetailsFor(items)
      const coverage = fieldCoverage(q, referenceDetails)
      candidates.push({
        sourceRef,
        sourceId: sourceRef.sourceId,
        provenance: normalizeProvenance(primary.provenance),
        title: primary.title || primary.topic,
        path: pathFor(primary.topic, sourceRef.section),
        source: 'wiki',
        matchReason: buildMatchReason(items, coverage, businessMatches),
        summary: cleanText(primary.content, 320),
        referenceDetails,
        ...coverage,
        version: primary.version ? `${primary.version}:${sourceHash}` : sourceHash,
        sourceHash,
        sectionCount: items.length,
        complete: false,
        kind: 'unknown',
        sourceRole: 'wiki',
        derived: false,
        independentEvidence: true,
        mode,
        roomKey
      })
    }
    return result(candidates.length ? 'ok' : 'no_results', {
      candidates,
      complete: Boolean(searched.complete),
      filteredCount,
      ...(candidates.length ? {} : { matchReason: noRelevantCandidatesReason(relevance.terms.length) })
    })
  }

  async function readSource({ roomKey, sourceRef, mode = 'business', actor, requestCache } = {}) {
    const topic = parseTopicName(sourceRef && sourceRef.topic)
    const query = String(sourceRef && sourceRef.query || '').trim().slice(0, MAX_QUERY_CHARS)
    if (!sourceRef || sourceRef.type !== 'wiki_compiler' || !roomKey || !topic || !query || !['business', 'demo'].includes(mode) ||
      !sourceRef.chunkId || String(sourceRef.roomId || '') !== String(roomKey)) {
      return result(sourceRef && sourceRef.roomId && String(sourceRef.roomId) !== String(roomKey) ? 'forbidden' : 'error', {
        sourceRef: sourceRef || null,
        error: sourceRef && sourceRef.roomId && String(sourceRef.roomId) !== String(roomKey) ? 'cross_room_source_ref' : 'invalid_source_ref',
        complete: false,
        truncated: false
      })
    }

    const wanted = matchesOf(sourceRef)
    const currentSearch = await search(query, { roomKey, actor, mode, requestCache })
    if (currentSearch.status !== 'ok') {
      return { ...currentSearch, sourceRef, complete: false, truncated: false, content: '' }
    }
    const currentItems = []
    for (const match of wanted) {
      const found = currentSearch.candidates.find(({ item }) => item.chunkId === match.chunkId)
      const item = found && found.item
      if (!item || item.topic !== topic || !matchIsCurrent(match, item)) {
        return result('no_results', { sourceRef, error: 'wiki_chunk_not_current', complete: false, truncated: false })
      }
      if (mode === 'business' && item.provenance.origin === 'demo') {
        return result('forbidden', { sourceRef, error: 'wiki_demo_source_not_allowed', complete: false, truncated: false })
      }
      currentItems.push(item)
    }

    const configured = configuredBaseUrl(env)
    if (configured.error) return result('unavailable', { sourceRef, error: configured.error, complete: false, truncated: false })
    const read = await requestJson(makeTopicUrl(configured.url, topic), {
      operation: 'topic', actor, requestCache,
      cacheKey: `wiki-topic:${configured.url.origin}:${roomKey}:${String(actor && (actor.id || actor.userId || actor.sub) || '')}:${mode}:${topic}`
    })
    if (read.status !== 'ok') return {
      ...read, sourceRef, title: topic, path: pathFor(topic, sourceRef.section),
      sourceId: sourceIdFor({ type: 'wiki_compiler', roomId: roomKey, topic }),
      complete: false, truncated: read.error === 'wiki_response_too_large', content: ''
    }

    const data = read.value
    const meta = data.meta && typeof data.meta === 'object' ? data.meta : null
    const topicCacheKey = `wiki-topic:${configured.url.origin}:${roomKey}:${String(actor && (actor.id || actor.userId || actor.sub) || '')}:${mode}:${topic}`
    if (!meta || !Array.isArray(data.sections) || data.sections.some(section =>
      !section || typeof section.heading !== 'string' || typeof section.content !== 'string'
    ) || !String(data.title || data.slug || '').trim() ||
      String(meta.status || '').toLowerCase() !== 'active') {
      cacheDelete(requestCache, topicCacheKey)
      return result('parse_failed', { sourceRef, error: 'wiki_topic_not_complete', complete: false, truncated: false, content: '' })
    }
    if (String(data.slug || meta.topic || '') !== topic) {
      cacheDelete(requestCache, topicCacheKey)
      return result('no_results', { sourceRef, error: 'wiki_topic_changed', complete: false, truncated: false, content: '' })
    }
    const provenance = normalizeProvenance(data.provenance)
    const currentProvenance = normalizeProvenance(currentItems[0] && currentItems[0].provenance)
    if (provenance.origin !== currentProvenance.origin || provenance.sourceId !== currentProvenance.sourceId ||
      provenance.sourceTitle !== currentProvenance.sourceTitle) {
      cacheDelete(requestCache, topicCacheKey)
      return result('no_results', { sourceRef, error: 'wiki_provenance_changed', complete: false, truncated: false, content: '' })
    }
    if (mode === 'business' && provenance.origin === 'demo') {
      return result('forbidden', { sourceRef, error: 'wiki_demo_source_not_allowed', complete: false, truncated: false, content: '' })
    }
    for (const match of wanted) {
      const matchedContent = sectionContent(data, match.section)
      if (matchedContent == null || sha256(matchedContent) !== match.chunkHash) {
        cacheDelete(requestCache, topicCacheKey)
        return result('no_results', { sourceRef, error: 'wiki_chunk_changed', complete: false, truncated: false, content: '' })
      }
    }
    const content = renderTopic(data)
    const sourceHash = sha256(content)
    const truncated = content.length > MAX_SOURCE_CHARS
    const returnedContent = truncated ? content.slice(0, MAX_SOURCE_CHARS) : content
    const sourcePaths = [...new Set(currentItems.flatMap(item => item.sourcePaths || []))].slice(0, 30)
    const verifiedSourceRef = makeSourceRef(roomKey, query, currentItems)
    const referenceDetails = referenceDetailsFor([], { complete: !truncated, allSections: data.sections })
    return result('ok', {
      sourceRef: verifiedSourceRef,
      sourceId: verifiedSourceRef.sourceId,
      provenance,
      title: String(data.title || data.slug),
      path: pathFor(topic, sourceRef.section),
      sourcePaths,
      version: `${String(meta.last_compiled || currentItems[0] && currentItems[0].version || '')}:${sourceHash}:${sha256(JSON.stringify(provenance))}`,
      sourceHash,
      content: returnedContent,
      sectionCount: wanted.length,
      coverage: {
        kind: 'full_topic',
        sectionCount: data.sections.length,
        complete: !truncated
      },
      referenceDetails,
      ...fieldCoverage(query, referenceDetails),
      complete: !truncated && Boolean(content),
      truncated,
      kind: !truncated ? classifyTopic(content) : 'unknown',
      sourceRole: 'wiki',
      derived: false,
      independentEvidence: true,
      mode,
      error: truncated ? 'wiki_topic_too_large' : undefined
    })
  }

  return { searchSources, readSource }
}

function requestedFields(query) {
  const text = String(query || '')
  return Object.entries(FIELD_QUERY_TERMS)
    .filter(([, terms]) => terms.some(term => text.includes(term)))
    .map(([field]) => field)
}

function fieldCoverage(query, details) {
  const requiredFields = requestedFields(query)
  const fields = details && details.fields || {}
  return {
    requiredFields,
    matchedFields: requiredFields.filter(field => Array.isArray(fields[field]) && fields[field].length),
    unmatchedFields: requiredFields.filter(field => !Array.isArray(fields[field]) || !fields[field].length),
    fieldCoverageComplete: Boolean(details && details.complete)
  }
}

function buildMatchReason(items, coverage = {}, businessMatches = []) {
  const sections = [...new Set(items.map(item => item.section).filter(Boolean))].slice(0, 5)
  const parts = []
  if (businessMatches.length) parts.push(`命中业务词：${businessMatches.slice(0, 8).join('、')}`)
  const matched = (coverage.matchedFields || []).map(field => FIELD_LABELS[field] || field)
  const unmatched = (coverage.unmatchedFields || []).map(field => FIELD_LABELS[field] || field)
  if (matched.length) parts.push(`命中字段：${matched.join('、')}`)
  if (unmatched.length && !coverage.fieldCoverageComplete) parts.push(`命中片段未覆盖：${unmatched.join('、')}`)
  if (sections.length) parts.push(`相关小节：${sections.join('、')}`)
  if (businessMatches.length) parts.push('仅为相关候选，需人工确认适用性')
  return parts.join('；') || '与当前业务上下文匹配，需确认是否适用于本链路'
}

function normalizeRelevanceText(value) {
  return cleanText(value, MAX_RELEVANCE_TEXT_CHARS)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/(?:^|[\s,，;；])(?:c|p|d)\s*[:：]/giu, ' ')
    .replace(/\b(?:c|p|d)\b/giu, ' ')
    .replace(/每(?:周|星期|月|季度|年|天|日|次|班|小时|工作日)/gu, ' ')
    .replace(/\d+(?:[.,]\d+)*(?:[%％])?/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function businessTokensFromText(value) {
  let text = normalizeRelevanceText(value)
  for (const term of BUSINESS_CONTEXT_STOP_TERMS) {
    text = text.replace(new RegExp(escapeRegExp(term), 'giu'), ' ')
  }
  const tokens = []
  for (const chunk of text.split(/\s+/u).filter(Boolean)) {
    if (/\p{Script=Han}/u.test(chunk)) {
      const runs = chunk.match(/\p{Script=Han}+/gu) || []
      for (const run of runs) {
        const chars = [...run]
        if (chars.length >= 2) tokens.push(run.slice(0, 80))
      }
    } else if ([...chunk].length >= 3) {
      tokens.push(chunk)
    }
    if (tokens.length >= MAX_BUSINESS_TERMS) break
  }
  return [...new Set(tokens)].slice(0, MAX_BUSINESS_TERMS)
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function businessRelevanceTerms(businessContext, query) {
  const explicit = Boolean(businessContext && typeof businessContext === 'object' && Array.isArray(businessContext.texts))
  const supplied = explicit
    ? businessContext.texts.filter(value => typeof value === 'string' && value.trim()).slice(0, MAX_BUSINESS_CONTEXT_TEXTS)
    : []
  const texts = explicit ? supplied : [query]
  const terms = [...new Set(texts.flatMap(value => businessTokensFromText(value.slice(0, MAX_BUSINESS_CONTEXT_TEXT_CHARS))))]
    .slice(0, MAX_BUSINESS_TERMS)
  return { terms, explicit }
}

function matchingBusinessTerms(terms, items) {
  if (!terms.length) return []
  const haystack = normalizeRelevanceText(items
    .map(item => `${item.topic || ''} ${item.section || ''} ${item.content || ''}`)
    .join(' '))
  const compact = haystack.replace(/\s+/gu, '')
  const matches = []
  for (const phrase of terms) {
    if (compact.includes(phrase)) {
      matches.push(phrase)
      continue
    }
    if (!/^\p{Script=Han}+$/u.test(phrase)) continue
    const chars = [...phrase]
    if (chars.length < 3) continue
    // Allow literal Chinese subphrase overlap for alternate word boundaries
    // while avoiding invented semantic equivalences or arbitrary score cutoffs.
    for (const size of [5, 4, 3]) {
      if (chars.length < size) continue
      let found = false
      for (let index = 0; index + size <= chars.length; index += 1) {
        const subphrase = chars.slice(index, index + size).join('')
        if (compact.includes(subphrase)) {
          matches.push(subphrase)
          found = true
          break
        }
      }
      if (found) break
    }
  }
  return [...new Set(matches)].slice(0, 8)
}

function noRelevantCandidatesReason(termCount) {
  return termCount
    ? '未找到与当前业务相关的 Wiki SOP'
    : '未找到与当前业务相关的 Wiki SOP：查询中没有可用于判断相关性的业务关键词，已跳过候选'
}

module.exports = {
  createWikiProvider,
  sourceIdFor,
  _internals: {
    configuredBaseUrl,
    endpointUrl,
    makeTopicUrl,
    normalizeSearchItem,
    makeSourceRef,
    matchesOf,
    renderTopic,
    sha256,
    normalizeProvenance,
    referenceDetailsFor,
    buildMatchReason,
    requestedFields,
    fieldCoverage,
    cacheRead,
    cacheWrite,
    cacheDelete,
    sourceIdFor
  }
}
