'use strict'

const crypto = require('crypto')
const store = require('./store')
const rules = require('./rules')
const chainUtils = require('./chain')
const { checkRunFreshness } = require('./freshness')
const { applyChainEvidence } = require('./localEvidence')
const { sourceIdFor, digest } = require('./identity')
const reportContract = () => require('./reportContract')

const inFlight = new Map()
const initializedDbs = new WeakMap()
const SEARCH_SCOPES = ['map_knowledge', 'company_ai', 'wiki']

class CheckError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

function getDb(deps) {
  const db = deps && (deps.db || deps.pool)
  if (!db || typeof db.query !== 'function') throw new Error('checkRuns requires deps.db.query')
  return db
}

async function initSchema(db) {
  return store.ensureSchema(db)
}

async function ensureInitialized(db) {
  if (initializedDbs.has(db)) return initializedDbs.get(db)
  const pending = store.ensureSchema(db).catch(err => {
    initializedDbs.delete(db)
    throw err
  })
  initializedDbs.set(db, pending)
  return pending
}

function actorId(actor) {
  if (typeof actor === 'string' || typeof actor === 'number') return String(actor).trim()
  if (!actor || typeof actor !== 'object') return ''
  return String(actor.id || actor.userId || actor.user_id || actor.sub || '').trim()
}

function assertIdentity(roomKey, actor, requestId) {
  if (!String(roomKey || '').trim()) throw new CheckError(400, 'BAD_ROOM', '缺少 roomKey')
  if (!actorId(actor)) throw new CheckError(401, 'AUTH_REQUIRED', '检查操作需要已认证的用户')
  if (!String(requestId || '').trim()) throw new CheckError(400, 'REQUEST_ID_REQUIRED', '缺少检查请求 ID')
}

function mapVersionOf(snapshot) {
  const value = snapshot && (snapshot.mapVersion != null ? snapshot.mapVersion : snapshot.version)
  return value == null ? '' : String(value)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sourceKey(sourceRef) {
  return stableJson(sourceRef || null)
}

function sourceContentHash(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex')
}

function pathTextOf(path) {
  if (Array.isArray(path)) {
    return path.map(part => {
      if (part && typeof part === 'object') return part.text || part.title || part.name || part.uid || ''
      return String(part || '')
    }).filter(Boolean).join(' / ')
  }
  return String(path || '')
}

function sourceContextFor(snapshot, chain) {
  const nodes = chainUtils.nodesOf(snapshot)
  const parents = chainUtils.buildParents(nodes)
  return {
    nodes,
    pathForUid(uid) {
      if (!uid || !nodes[uid]) return []
      return chainUtils.pathFor(nodes, parents, uid)
    }
  }
}

function sourceMetadata(source, context = {}) {
  const sourceRef = source && source.sourceRef || null
  const nodeUid = source && (source.nodeUid || source.node_uid) ||
    sourceRef && (sourceRef.nodeUid || sourceRef.uid) || null
  let path = source && (source.path || source.pathText || source.path_text) || null
  let pathText = String(source && (source.pathText || source.path_text) || '')
  if (path && !pathText && !Array.isArray(path)) pathText = String(path)
  if (Array.isArray(path) && !pathText) pathText = pathTextOf(path)
  // A path made only of node UIDs is not a readable location: re-resolve it
  // from the live chain so the report shows real ancestor titles instead.
  const uidOnlyPath = /^[\s0-9a-f/-]+$/i
  const pathHasText = Array.isArray(path)
    ? path.some(part => part && typeof part === 'object' && (part.text || part.title))
    : Boolean(pathText && !uidOnlyPath.test(pathText))
  if (!pathHasText && nodeUid && typeof context.pathForUid === 'function') {
    const parts = context.pathForUid(nodeUid)
    if (Array.isArray(parts) && parts.length) {
      path = parts
      pathText = pathTextOf(parts)
    }
  }
  if (!path && !pathText && sourceRef && typeof sourceRef.path === 'string') {
    path = sourceRef.path
    pathText = sourceRef.path
  }
  const sourcePaths = source && source.sourcePaths || sourceRef && sourceRef.sourcePaths
  const filename = String(source && (source.filename || source.file_name) || '') ||
    (sourceRef && sourceRef.type === 'attachment' && source && source.title ? String(source.title) : '')
  return {
    sourceRef,
    sourceId: sourceIdFor(sourceRef || {}),
    provenance: source && source.provenance || { origin: 'unknown' },
    nodeUid,
    title: String(source && source.title || ''),
    source: String(source && source.source || sourceRef && sourceRef.type || ''),
    sourceRole: String(source && source.sourceRole || (sourceRef && ['attachment', 'chain_node'].includes(sourceRef.type) ? 'current_chain' : 'external_reference')),
    path: path || null,
    pathText,
    filename,
    sourcePaths: Array.isArray(sourcePaths)
      ? sourcePaths.filter(item => typeof item === 'string' && item.trim()).slice(0, 30)
      : [],
    version: source && source.version == null ? '' : String(source.version),
    status: String(source && source.status || 'unknown'),
    complete: source && source.complete !== false && !source.truncated,
    truncated: !!(source && source.truncated),
    independentEvidence: source && source.independentEvidence !== false && !source.derived,
    contentHash: sourceContentHash(source && source.content || '')
  }
}

function sourceIdentity(source) {
  const ref = source && source.sourceRef || {}
  const type = String(ref.type || source && source.source || '')
  let identity = ''
  if (type === 'attachment') identity = ref.id || ref.attachmentId || source && source.nodeUid
  else if (type === 'wiki_compiler') identity = [ref.topic, ref.section || ref.chunkId].filter(Boolean).join('::')
  else if (type === 'map_node' || type === 'chain_node') identity = ref.uid || ref.nodeUid || source && source.nodeUid
  else identity = ref.path || ref.uid || ref.id || [ref.topicKey, ref.slot].filter(Boolean).join('/')
  return [
    type,
    ref.roomId || ref.roomKey || '',
    identity,
    source && source.version,
    source && source.contentHash
  ].map(value => String(value || '')).join('|')
}

function mergeSourceMetadata(base, extra) {
  const merged = { ...base }
  for (const key of ['path', 'pathText', 'filename', 'title', 'status', 'version', 'sourceRef']) {
    const current = merged[key]
    const missing = current == null || current === '' || current === 'unknown' ||
      Array.isArray(current) && !current.length
    if (missing && extra[key] != null && extra[key] !== '') merged[key] = extra[key]
  }
  for (const key of ['sourcePaths']) {
    const current = Array.isArray(merged[key]) ? merged[key] : []
    const incoming = Array.isArray(extra[key]) ? extra[key] : []
    merged[key] = [...new Set([...current, ...incoming])].slice(0, 30)
  }
  return merged
}

function dedupeSources(sources) {
  const merged = new Map()
  for (const source of sources || []) {
    if (!source) continue
    const key = sourceIdentity(source)
    const existing = merged.get(key)
    merged.set(key, existing ? mergeSourceMetadata(existing, source) : source)
  }
  return [...merged.values()]
}

function snapshotSources(snapshot, chain) {
  const uids = new Set((chain && chain.nodeUids) || [])
  return (Array.isArray(snapshot && snapshot.sources) ? snapshot.sources : [])
    .filter(source => {
      const uid = source.nodeUid || source.node_uid || source.sourceRef && source.sourceRef.nodeUid
      return !uid || uids.has(uid)
    })
}

function sourceRefsForSnapshot(snapshot, chain, context) {
  return snapshotSources(snapshot, chain).map(source => sourceMetadata({ ...source, sourceRole: 'current_chain' }, context))
}

function labelledText(items, label) {
  return (items || []).map(item => {
    const parts = [`${label}：${item.text || ''}`]
    if (item.note) parts.push(`备注：${item.note}`)
    return parts.join('\n')
  }).join('\n')
}

function manualReviewFinding({ ruleId, title, nodeUid, message, evidence }) {
  return {
    ...rules.finding({ ruleId, title, nodeUid, status: 'needs_info', severity: 'blocker', message, evidence }),
    validationType: 'manual_text_review'
  }
}

function manualTextReviewFindings(chain, data) {
  const findings = []
  if (data.dNodes.length) {
    const dText = labelledText(data.dNodes, 'D')
    const stepText = labelledText(data.steps, '步骤')
    findings.push(manualReviewFinding({
      ruleId: 'CK-10', title: 'D 粒度可执行', nodeUid: data.dNodes[0].uid,
      message: '程序已读取 D 与执行步骤原文，但无法仅凭结构和字段判断动作是否足够具体、可执行或便于交接，请结合原文核对。',
      evidence: [dText, stepText].filter(Boolean).join('\n')
    }))
  }

  const checkRoots = new Set(chain.checkRootUids || [])
  const planRoots = new Set(chain.planRootUids || [])
  const checks = data.checkNodes.filter(item => item.leaf ||
    item.role === 'C' && !chainUtils.isBareRoleLabel(item.text) ||
    checkRoots.has(item.uid) && !chainUtils.isBareRoleLabel(item.text))
  const plans = data.planNodes.filter(item =>
    item.role === 'P' && !chainUtils.isBareRoleLabel(item.text) ||
    item.leaf && !planRoots.has(item.uid))
  if (checks.length && plans.length) {
    const cText = labelledText(checks, 'C 原文')
    const pText = labelledText(plans, 'P 原文')
    const evidence = `${cText}\n${pText}`
    findings.push(manualReviewFinding({
      ruleId: 'CK-27', title: 'C 项对应 P 目标', nodeUid: checks[0].uid,
      message: `已列出本链 ${checks.length} 项 C 与 ${plans.length} 项 P 原文；程序不根据层级或相似词推断目标对应关系，请按原文核对。`,
      evidence
    }))
    findings.push(manualReviewFinding({
      ruleId: 'CK-28', title: 'P 目标有 C 收口', nodeUid: plans[0].uid,
      message: `已列出本链 ${plans.length} 项 P 与 ${checks.length} 项 C 原文；程序不根据层级或相似词推断目标收口关系，请按原文核对。`,
      evidence
    }))
  }
  return findings
}

function parseRoleSections(content) {
  const sections = { C: [], P: [], D: [] }
  let active = ''
  const rolePattern = /^\s*(?:[-*+•]\s*)?(?:\d+[.)、]\s*)?(C|检查|目标|P|计划|D|执行|动作|AI|人)\s*[:：]\s*(.*)$/i
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/^\s*\[[^\]]+\]\s*/, '')
    const match = line.match(rolePattern)
    if (match) {
      const role = match[1].toUpperCase()
      active = ['C', '检查', '目标'].includes(role) ? 'C' : ['P', '计划'].includes(role) ? 'P' : 'D'
      sections[active].push(match[2].trim())
    } else if (active && line.trim()) {
      sections[active][sections[active].length - 1] += `\n${line.trim()}`
    }
  }
  return sections
}

function explicitValues(items, field) {
  const values = []
  for (const item of items || []) {
    const node = item.rawNode || {}
    const data = node.data && typeof node.data === 'object' ? node.data : {}
    const value = data[field] != null && String(data[field]).trim()
      ? String(data[field]).trim()
      : rules.fieldValue(`${item.text || ''}\n${item.note || ''}`, field)
    if (value) values.push({ nodeUid: item.uid || '', value })
  }
  return values
}

function compareReferenceFields(data, source) {
  const reference = parseRoleSections(source.content)
  const withRawNodes = items => items.map(item => ({ ...item, rawNode: data.nodes[item.uid] }))
  const currentFields = {
    targetValue: explicitValues(withRawNodes([...data.checkNodes, ...data.planNodes]), 'targetValue'),
    frequency: explicitValues(withRawNodes(data.dNodes), 'frequency'),
    inputs: explicitValues(withRawNodes(data.dNodes), 'inputs'),
    criterion: explicitValues(withRawNodes(data.dNodes), 'criterion'),
    owner: explicitValues(withRawNodes(data.dNodes), 'owner'),
    outputs: explicitValues(withRawNodes(data.dNodes), 'outputs')
  }
  const referenceFieldValues = field => {
    const texts = field === 'targetValue' ? [...reference.C, ...reference.P] : reference.D
    return texts.map(text => rules.fieldValue(text, field)).filter(Boolean)
  }
  return Object.entries(currentFields).map(([field, current]) => {
    const referenceValues = referenceFieldValues(field)
    const currentValues = [...new Set(current.map(item => item.value))]
    const distinctReference = [...new Set(referenceValues)]
    return {
      field,
      currentValues: currentValues.map(value => ({ value,
        nodeUids: current.filter(item => item.value === value).map(item => item.nodeUid) })),
      referenceValues: distinctReference,
      comparison: currentValues.length && distinctReference.length
        ? currentValues.length === distinctReference.length && currentValues.every(value => distinctReference.includes(value))
          ? 'exact_match'
          : currentValues.some(value => distinctReference.includes(value)) ? 'partial_match' : 'different'
        : currentValues.length ? 'not_explicit_in_reference'
          : distinctReference.length ? 'not_explicit_in_chain' : 'not_available'
    }
  })
}

function referenceComparison(data, source) {
  const reference = parseRoleSections(source.content)
  return {
    mode: 'reference_only',
    note: '选定流程仅作参考。以下列出 C/P/D 原文和可直接读取的字段值，不判断目标含义是否对应。',
    source: sourceMetadata(source),
    chain: {
      C: data.checkNodes.map(item => ({ uid: item.uid, text: item.text, note: item.note || '' })),
      P: data.planNodes.map(item => ({ uid: item.uid, text: item.text, note: item.note || '' })),
      D: data.dNodes.map(item => ({ uid: item.uid, text: item.text, note: item.note || '' }))
    },
    reference,
    fields: compareReferenceFields(data, source)
  }
}

function summarizeStatus(findings, explicitStatus) {
  if (explicitStatus) return explicitStatus
  if (findings.some(item => item.status === 'failed' && item.severity === 'blocker')) return 'blocked'
  if (findings.some(item => item.status === 'needs_confirmation' && item.severity === 'blocker')) return 'needs_confirmation'
  if (findings.some(item => item.status === 'needs_info' && item.severity === 'blocker')) return 'needs_confirmation'
  if (findings.some(item => item.status === 'needs_supplement' && item.severity === 'blocker')) return 'needs_supplement'
  return 'passed'
}

function summaryOf(findings) {
  const counted = (findings || []).filter(item => item.ruleId !== 'CK-32')
  return {
    passed: counted.filter(item => item.status === 'passed').length,
    blockers: counted.filter(item => item.severity === 'blocker' && ['failed','needs_info','needs_supplement','needs_confirmation'].includes(item.status)).length,
    needsSupplement: counted.filter(item => item.status === 'needs_supplement').length,
    warnings: counted.filter(item => item.severity === 'warning' && item.status !== 'passed').length,
    notApplicable: counted.filter(item => item.status === 'not_applicable').length
  }
}

function candidateKind(candidate) {
  return ['flow','material','unknown'].includes(candidate && candidate.kind) ? candidate.kind : 'unknown'
}

function sanitizeCandidate(candidate) {
  const sourceRef = candidate && candidate.sourceRef && typeof candidate.sourceRef === 'object' ? candidate.sourceRef : null
  const candidateId = String(candidate && candidate.candidateId || sourceKey(sourceRef) + ':' + String(candidate && candidate.title || ''))
  return {
    candidateId,
    kind: candidateKind(candidate),
    sourceRole: String(candidate && candidate.sourceRole || ''),
    provenance: candidate && candidate.provenance || { origin: 'unknown' },
    referenceDetails: candidate && candidate.referenceDetails || null,
    sourceRef,
    title: String(candidate && candidate.title || ''),
    path: String(candidate && candidate.path || ''),
    source: String(candidate && candidate.source || ''),
    matchReason: String(candidate && candidate.matchReason || ''),
    summary: String(candidate && candidate.summary || ''),
    version: candidate && candidate.version == null ? '' : String(candidate.version),
    complete: candidate && candidate.complete !== false,
    independentEvidence: candidate && candidate.independentEvidence !== false && !candidate.derived,
    derived: !!(candidate && candidate.derived)
  }
}

function candidateInChain(candidate, chain) {
  const ref = candidate && candidate.sourceRef || {}
  const uid = String(ref.uid || ref.nodeUid || '')
  return uid && (chain.nodeUids || []).map(String).includes(uid)
}

function chainDescription(snapshot, chain) {
  const nodes = chainUtils.nodesOf(snapshot)
  const data = chainUtils.collectChainData(snapshot, chain)
  return {
    chainUid: chain.chainUid,
    title: chain.title,
    path: chain.path,
    pathText: chain.pathText,
    checkRootUids: chain.checkRootUids,
    planRootUids: chain.planRootUids,
    executionUids: chain.executionUids,
    nodeUids: chain.nodeUids,
    auditNodeUids: chain.auditNodeUids || chain.nodeUids,
    contextNodeUids: chain.contextNodeUids || [],
    check: data.checkNodes.map(item => ({ uid: item.uid, text: item.text, note: item.note })),
    plan: data.planNodes.map(item => ({ uid: item.uid, text: item.text, note: item.note })),
    execution: [...data.dNodes, ...data.steps].map(item => ({ uid: item.uid, text: item.text, note: item.note }))
  }
}

function candidateReport(candidate, snapshot) {
  const data = snapshot && typeof snapshot === 'object' ? chainUtils.collectChainData(snapshot, candidate) : null
  const summary = data ? `C: ${data.checkNodes.map(item => item.text).slice(0, 6).join('、')}；P: ${data.planNodes.map(item => item.text).slice(0, 6).join('、')}；D: ${data.dNodes.map(item => item.text).slice(0, 6).join('、')}` : ''
  return {
    kind: 'flow', source: 'chain', summary: summary.slice(0, 1200),
    candidateId: candidate.candidateId,
    chainUid: candidate.chainUid,
    title: candidate.title,
    referenceDetails: data ? { complete: true,
      C: data.checkNodes.map(item => item.text), P: data.planNodes.map(item => item.text),
      D: data.dNodes.map(item => item.text), fields: {} } : null,
    path: candidate.path,
    pathText: candidate.pathText,
    checkRootUids: candidate.checkRootUids,
    planRootUids: candidate.planRootUids,
    executionUids: candidate.executionUids,
    nodeUids: candidate.nodeUids
  }
}

function isMissingFinding(item) {
  return item.severity === 'blocker' && item.validationType !== 'manual_text_review' &&
    ['needs_supplement','needs_info','needs_confirmation'].includes(item.status)
}

const QUERY_MAX_CHARS = 240
const MATERIAL_LABEL_FIELDS = new Set(['frequency', 'inputs', 'outputs'])

function buildQuery(snapshot, chain, findings) {
  const nodes = chainUtils.nodesOf(snapshot)
  const business = []
  const fields = []
  findings.forEach(item => {
    if (item.nodeUid && nodes[item.nodeUid]) business.push(chainUtils.nodeText(nodes[item.nodeUid]))
    if (item.ruleId === 'CK-29' && item.quote) business.push(item.quote)
    const label = rules.fieldLabel(item.field)
    if (label) fields.push(label)
  })
  const pathTexts = (chain.path || []).map(item => item && item.text).filter(Boolean)
  const chainText = pathTexts.find(text => !chainUtils.isBareRoleLabel(text)) ||
    chainUtils.nodeText(nodes[chain.chainUid])
  return [...new Set([chainText, ...business, ...fields].filter(Boolean))]
    .join(' ')
    .slice(0, QUERY_MAX_CHARS)
}

function materialMatchFor(item, content) {
  const text = String(content || '')
  if (!text) return null
  if (item.field === 'reference') {
    const term = String(item.materialTerm || '') ||
      String(item.message || '').match(/[“「]([^”」]+)[”」]/)?.[1] || ''
    if (!term) return null
    const at = text.toLowerCase().indexOf(term.toLowerCase())
    if (at < 0) return null
    return {
      term,
      quote: text.slice(Math.max(0, at - 30), at + term.length + 100),
      reason: '完整来源包含所需材料；当前图尚未补入引用，检查仍待补齐。'
    }
  }
  if (MATERIAL_LABEL_FIELDS.has(item.field)) {
    const value = rules.fieldValue(text, item.field)
    if (!value) return null
    const at = text.toLowerCase().indexOf(String(value).toLowerCase())
    return {
      term: value,
      quote: at < 0 ? text.slice(0, 180) : text.slice(Math.max(0, at - 30), at + String(value).length + 100),
      reason: '完整来源包含该字段的明确取值，需人工核对是否适用于本链路；当前图仍缺该字段。'
    }
  }
  return null
}

async function searchForCandidates({ roomKey, actor, snapshot, chain, report, deps, startAt = 0 }) {
  deps = { ...deps, requestCache: deps.requestCache || new Map() }
  const readBodies = []
  const search = getProvider(deps, 'searchSources')
  const read = getProvider(deps, 'readSource')
  const local = applyChainEvidence(snapshot, chain, report.findings, { roomKey })
  report.findings = local.findings
  const materials = [...(report.materialCandidates || []), ...local.localMaterialCandidates]
  const sourceRefs = [...(report.sources || [])]
  const context = sourceContextFor(snapshot, chain)
  const pending = local.unresolvedForSearch.filter(item => item.validationType !== 'manual_text_review')
  report.materialCandidates = [...new Map(materials.map(item => [item.candidateId, item])).values()]
  if (!pending.length) {
    report.findings.push(...rules.sourceSearchFindings([], []))
    report.status = summarizeStatus(report.findings)
    report.summary = summaryOf(report.findings)
    return { report, sourceRefs }
  }
  if (typeof search !== 'function') {
    report.sourceStatuses.push({ scope: 'map_knowledge', status: 'unavailable', error: 'provider_not_configured' })
  } else {
    const query = buildQuery(snapshot, chain, pending)
    const chainContext = { ...chainDescription(snapshot, chain), excludeUids: chain.nodeUids }
    for (let index = startAt; index < SEARCH_SCOPES.length; index++) {
      const scope = SEARCH_SCOPES[index]
      let result
      try { result = await search({ roomKey, query, scope, chain: chainContext, actor, mode: deps.mode || 'business', requestCache: deps.requestCache }) }
      catch (_) { result = { status: 'error', candidates: [], error: 'search_failed' } }
      const raw = (Array.isArray(result && result.candidates) ? result.candidates : [])
        .map(sanitizeCandidate).filter(item => item.title && item.sourceRef && !candidateInChain(item, chain))
      const flows = []
      const reads = []
      // Only read unknown/material previews here. Confirmed flow bodies are read
      // after the user chooses one; no score makes that choice for them.
      for (let offset = 0; offset < raw.length; offset += 4) {
        const batch = await Promise.allSettled(raw.slice(offset, offset + 4).map(async candidate => {
          if (candidate.kind === 'flow') return { candidate }
          if (typeof read !== 'function') return { candidate, body: { status: 'unavailable', complete: false } }
          try { return { candidate, body: await read({ roomKey, sourceRef: candidate.sourceRef, actor, mode: deps.mode || 'business', requestCache: deps.requestCache }) } }
          catch (_) { return { candidate, body: { status: 'error', complete: false } } }
        }))
        for (const settled of batch) {
          if (settled.status !== 'fulfilled') continue
          const { candidate, body } = settled.value
          if (!body) { flows.push(candidate); continue }
          reads.push({ scope, candidateId: candidate.candidateId, sourceRef: candidate.sourceRef, sourceId: sourceIdFor(candidate.sourceRef), title: candidate.title, status: body.status || 'error',
            error: body.error || (body.truncated ? 'truncated' : body.complete !== true ? 'incomplete' : '') })
          if (body.status !== 'ok' || body.complete !== true || body.truncated || !String(body.content || '').trim()) {
            sourceRefs.push(sourceMetadata({ ...candidate, ...body, sourceRef: candidate.sourceRef, complete: false }, context))
            continue
          }
          const complete = sourceEvidenceFromRead(body, candidate)
          readBodies.push(complete)
          if (body.kind === 'flow' || hasFlowStructure(complete.content)) {
            // Unconfirmed flow candidates are read only to classify them; their
            // bodies are not recorded as report sources until the user accepts a
            // candidate. Only the confirm step reads a flow body as evidence.
            const meta = sourceMetadata(complete, context)
            flows.push({ ...candidate, ...meta, referenceDetails: body.referenceDetails || candidate.referenceDetails, pathText: meta.pathText || candidate.pathText || '',
              kind: 'flow', complete: true, version: complete.version })
            continue
          }
          if (!(candidate.independentEvidence && complete.independentEvidence !== false)) continue
          const meta = sourceMetadata(complete, context)
          sourceRefs.push(meta)
          for (const item of pending) {
            const match = materialMatchFor(item, complete.content)
            if (!match) continue
            report.materialCandidates.push({ ...candidate, ...meta, kind: 'material', field: item.field,
              nodeUid: item.nodeUid, term: match.term, quote: match.quote,
              matchReason: match.reason })
            if (item.field === 'reference') item.externalMaterialFound = true
          }
        }
      }
      report.sourceStatuses.push({ scope, status: result && result.status || 'error', count: raw.length,
        error: result && (result.error || result.code) || '', errors: result && result.errors || [] }, ...reads)
      if (flows.length) {
        report.flowCandidates = flows
        report.candidates = flows
        report.selectionStage = 'source'
        report.searchCursor = index
        report.status = 'needs_confirmation'
        break
      }
      if (pending.every(item => item.externalMaterialFound)) break
    }
  }
  report.sources = dedupeSources(sourceRefs)
  report.materialCandidates = [...new Map(report.materialCandidates
    .map(item => [`${item.candidateId}:${item.nodeUid}:${item.field}`, item])).values()]
  report.findings.push(...rules.sourceSearchFindings(report.sourceStatuses, pending))
  if (report.selectionStage !== 'source') report.status = summarizeStatus(report.findings)
  report.summary = summaryOf(report.findings)
  return { report, sourceRefs: report.sources, readBodies }
}

function getProvider(deps, name) {
  const provider = deps && deps[name] || deps && deps.providers && deps.providers[name]
  if (name !== 'readSource' || typeof provider !== 'function') return provider
  return async args => {
    const cache = args.requestCache
    // Wiki maintains its own topic cache and validates individual search hits.
    if (!(cache instanceof Map) || args.sourceRef && args.sourceRef.type === 'wiki_compiler') return provider(args)
    const key = `check-read:${digest(stableJson([args.roomKey, args.actor, args.mode || 'business', sourceIdFor(args.sourceRef), args.sourceRef]))}`
    if (cache.has(key)) return cache.get(key)
    const pending = Promise.resolve().then(() => provider(args))
    cache.set(key, pending)
    try {
      const body = await pending
      if (!body || body.status !== 'ok' || body.complete !== true || body.truncated) cache.delete(key)
      return body
    } catch (error) {
      cache.delete(key)
      throw error
    }
  }
}

async function runFullCheck({ snapshot, nodeUid, chain, actor, deps, externalSources = [], includeSearch = true, sourceStatuses = [] }) {
  deps = { ...deps, requestCache: deps.requestCache || new Map() }
  const data = chainUtils.collectChainData(snapshot, chain)
  const baseFindings = [
    ...rules.checkStructure(snapshot, chain, data),
    ...rules.checkDFields(chain, data),
    ...rules.checkAcceptance(chain, data),
    ...rules.checkProgress(chain, data),
    ...rules.checkSopCard(snapshot, chain, data),
    ...rules.checkMaterials(chain, snapshot, data),
    ...rules.deferredFindings()
  ].map(item => (
    ['CK-11', 'CK-13'].includes(item.ruleId) && item.status === 'needs_info' ||
    item.ruleId === 'CK-29' && item.status === 'needs_info' && item.sourceRef && /需确认“[^”]+”与材料用途相符/.test(item.message || '')
  )
    ? { ...item, validationType: 'manual_text_review' }
    : item)
  const findings = [...baseFindings, ...manualTextReviewFindings(chain, data)]
  const local = applyChainEvidence(snapshot, chain, findings, { roomKey: deps.roomKey })
  const checkedFindings = local.findings
  const context = sourceContextFor(snapshot, chain)
  const externalMeta = externalSources.map(source => sourceMetadata(source, context))
  const localMeta = sourceRefsForSnapshot(snapshot, chain, context)
  const sourceRefs = dedupeSources([...localMeta, ...externalMeta])
  const enrichedFindings = checkedFindings.map(item => {
    if (!item.suggestedValue || item.status !== 'needs_supplement') return item
    const source = externalSources.find(candidate => String(candidate.content || '').includes(item.suggestedValue))
    return source ? { ...item, sourceRef: source.sourceRef || null, quote: source.content.includes(item.suggestedValue) ? item.suggestedValue : item.quote } : item
  })
  const report = {
    status: summarizeStatus(enrichedFindings),
    mode: deps.mode || 'business', revision: 1,
    ruleVersion: rules.RULE_VERSION,
    checkedAt: new Date().toISOString(),
    nodeFingerprint: chainUtils.fingerprintChain({ ...snapshot, sources: [] }, chain),
    chain: chainDescription(snapshot, chain),
    findings: enrichedFindings,
    sourceStatuses: sourceStatuses.slice(),
    sources: sourceRefs,
    flowCandidates: [],
    materialCandidates: local.localMaterialCandidates,
    selectionStage: null,
    summary: summaryOf(enrichedFindings)
  }
  const references = externalSources.filter(source => source.kind === 'flow' && source.complete === true && !source.truncated)
  if (references.length === 1) {
    report.selectedSources = [sourceMetadata(references[0], context)]
    report.referenceComparison = referenceComparison(data, references[0])
  }
  if (includeSearch && report.findings.some(isMissingFinding)) {
    const searched = await searchForCandidates({ roomKey: deps.roomKey, actor, snapshot, chain, report, deps })
    reportContract().decorateReport(searched.report, { snapshot, chain, externalSources: [...externalSources, ...(searched.readBodies || [])], mode: deps.mode || 'business' })
    return { ...searched, chainFingerprint: chainUtils.fingerprintChain(snapshot, chain), mapVersion: mapVersionOf(snapshot) }
  }
  reportContract().decorateReport(report, { snapshot, chain, externalSources, mode: deps.mode || 'business' })
  return { report, sourceRefs, chainFingerprint: chainUtils.fingerprintChain(snapshot, chain), mapVersion: mapVersionOf(snapshot) }
}

function failedReport({ nodeUid, ruleId = 'CK-12', message, status = 'blocked' }) {
  const finding = rules.finding({
    ruleId, title: 'CPD 链路定位', status: status === 'blocked' ? 'failed' : 'needs_info',
    severity: 'blocker', nodeUid, message
  })
  return {
    status,
    ruleVersion: rules.RULE_VERSION,
    checkedAt: new Date().toISOString(),
    chain: null,
    findings: [finding],
    sourceStatuses: [],
    sources: [],
    flowCandidates: [],
    materialCandidates: [],
    summary: summaryOf([finding])
  }
}

async function createCheck(input, deps = {}) {
  const mode = input.mode == null ? 'business' : String(input.mode)
  if (!['business', 'demo'].includes(mode)) throw new CheckError(400, 'INVALID_MODE', '检查模式必须为正式或演示')
  deps = { ...deps, mode, requestCache: new Map() }
  const roomKey = input && input.roomKey
  const nodeUid = input && input.nodeUid
  const actor = input && input.actor
  const requestId = String(input && input.requestId || '').trim()
  assertIdentity(roomKey, actor, requestId)
  const db = getDb(deps)
  await ensureInitialized(db)
  const key = `${roomKey}\n${actorId(actor)}\n${requestId}`
  if (inFlight.has(key)) {
    const pending = inFlight.get(key)
    if (String(pending.nodeUid) !== String(nodeUid) || pending.mode !== mode) throw new CheckError(409, 'REQUEST_TARGET_MISMATCH', '请求编号已用于其他节点或模式')
    return pending
  }
  const promise = (async () => {
    const existing = await store.getRunByRequest(db, roomKey, actorId(actor), requestId)
    if (existing) {
      if (String(existing.nodeUid) !== String(nodeUid) || (existing.report.mode || 'business') !== mode) throw new CheckError(409, 'REQUEST_TARGET_MISMATCH', '请求编号已用于其他节点或模式')
      return getCheck({ roomKey, runId: existing.runId, actor }, deps)
    }
    if (typeof deps.loadSnapshot !== 'function') throw new Error('checkRuns requires deps.loadSnapshot(roomKey,nodeUid)')
    const snapshot = await deps.loadSnapshot(roomKey, nodeUid)
    let reusable = null
    const previous = await store.listRuns(db, { roomKey, nodeUid, limit: 10 })
    for (const old of previous) {
      if ((old.report.mode || 'business') !== mode) continue
      if (!old.selection || old.selection.confirmationState !== 'complete') continue
      const fresh = await checkRunFreshness(old, deps, { actor, snapshot })
      if (!fresh.fresh) continue
      let source = null
      if (old.selection.sourceRef) {
        try { source = await getProvider(deps, 'readSource')({ roomKey, sourceRef: old.selection.sourceRef, actor, mode, requestCache: deps.requestCache }) } catch (_) {}
        if (!source || source.status !== 'ok' || !source.complete || source.truncated) continue
      }
      reusable = { old, chain: fresh.chain, source }
      break
    }
    if (!snapshot) throw new CheckError(404, 'NODE_NOT_FOUND', '找不到检查节点')
    const resolved = chainUtils.resolveCheckChain(snapshot, nodeUid, reusable && reusable.old.selection.chainCandidateId)
    let report
    let chainFingerprint = ''
    let sourceRefs = []
    if (resolved.status === 'needs_confirmation') {
      const candidates = resolved.candidates.map(candidate => candidateReport(candidate, snapshot))
      report = {
        status: 'needs_confirmation',
        ruleVersion: rules.RULE_VERSION,
        checkedAt: new Date().toISOString(),
        chain: null,
        findings: [rules.finding({
          ruleId: 'CK-21', title: 'CPD 对应流程确认', status: 'needs_confirmation', severity: 'blocker',
          nodeUid, message: '当前节点存在多个可能的 CPD 链路，请先确认对应流程。'
        })],
        flowCandidates: candidates,
        materialCandidates: [],
        candidates,
        selectionStage: 'flow',
        sourceStatuses: [],
        sources: [],
        summary: { passed: 0, blockers: 1, needsSupplement: 0, warnings: 0, notApplicable: 0 }
      }
      chainFingerprint = crypto.createHash('sha256').update(candidates.map(item => chainUtils.fingerprintChain(snapshot, item)).sort().join('|')).digest('hex')
    } else if (resolved.status !== 'resolved') {
      report = failedReport({ nodeUid, message: '当前节点无法定位到完整的 C/P 链路；请先确认或补充 CPD 结构。' })
      const nodes = chainUtils.nodesOf(snapshot)
      chainFingerprint = crypto.createHash('sha256').update(stableJson({ nodeUid, path: chainUtils.pathFor(nodes, chainUtils.buildParents(nodes), nodeUid) })).digest('hex')
    } else {
      const result = await runFullCheck({ snapshot, nodeUid, chain: resolved.chain, actor, deps: { ...deps, roomKey },
        externalSources: reusable && reusable.source ? [{ ...reusable.source,
          sourceRef: reusable.old.selection.sourceRef, candidateId: reusable.old.selection.candidateId,
          kind: 'flow' }] : [], includeSearch: !reusable })
      report = result.report
      if (reusable) report.selectionReused = true
      sourceRefs = result.sourceRefs
      chainFingerprint = result.chainFingerprint
    }
    report.mode = mode
    if (!(report.findings || []).every(item => item.findingKey)) reportContract().decorateReport(report, { snapshot, chain: resolved.chain, externalSources: reusable && reusable.source ? [reusable.source] : [], mode })
    report.revision = 1
    const reviewed = reusable && reusable.old || previous.find(old => (old.report.mode || 'business') === mode && old.ruleVersion === rules.RULE_VERSION && old.chainFingerprint === chainFingerprint && (old.report.reviewDecisions || []).length)
    if (reviewed && (await checkRunFreshness(reviewed, deps, { actor, snapshot })).fresh) reuseReviews(report, reviewed, chainFingerprint)
    const inserted = await store.createRun(db, {
      roomKey, nodeUid, actorId: actorId(actor), requestId,
      mapVersion: mapVersionOf(snapshot), chainFingerprint,
      ruleVersion: rules.RULE_VERSION, status: report.status,
      sourceRefs, selection: reusable ? { ...reusable.old.selection, stage: report.selectionStage || null } :
        { stage: report.selectionStage || (report.flowCandidates && report.flowCandidates.length ? 'flow' : null) },
      report
    })
    if (inserted.run && String(inserted.run.nodeUid) !== String(nodeUid)) {
      throw new CheckError(409, 'REQUEST_TARGET_MISMATCH', '请求编号已用于其他节点')
    }
    return inserted.run
  })().finally(() => inFlight.delete(key))
  promise.nodeUid = nodeUid
  promise.mode = mode
  inFlight.set(key, promise)
  return promise
}

function sourceEvidenceFromRead(read, candidate) {
  return {
    ...candidate,
    ...read,
    sourceRef: read && read.sourceRef || candidate.sourceRef,
    kind: read && read.kind || candidate.kind,
    content: String(read && read.content || ''),
    complete: !!(read && read.complete && !read.truncated),
    truncated: !!(read && read.truncated),
    version: String(read && read.version || candidate.version || ''),
    independentEvidence: read && read.independentEvidence != null ? read.independentEvidence : candidate.independentEvidence
  }
}

function hasFlowStructure(content) {
  const text = String(content || '').split(/\r?\n/).map(line => line
    .replace(/^\s*(?:[-*+•]\s*|\d+[.)、]\s*)/, '').replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').trim()).join('\n')
  const hasC = /(?:^|\n)(?:C|检查|目标)\s*(?:[:：]|$)/im.test(text)
  const hasP = /(?:^|\n)(?:P|计划)\s*(?:[:：]|$)/im.test(text)
  const hasD = /(?:^|\n)(?:D|执行|动作|AI|人)\s*(?:[:：]|$)/im.test(text)
  return hasC && hasP && hasD
}

function sourceFinding(status, candidate, message) {
  return rules.finding({
    ruleId: 'CK-30', title: '补充来源核验', status, severity: 'blocker',
    sourceRef: candidate && candidate.sourceRef || null,
    message
  })
}

async function confirmCheck(input, deps = {}) {
  const { roomKey, candidateId, actor } = input
  const runId = input.runId || input.checkRunId
  assertIdentity(roomKey, actor, 'confirmation')
  const db = getDb(deps)
  await ensureInitialized(db)
  const run = await store.getRun(db, roomKey, runId)
  if (!run) throw new CheckError(404, 'CHECK_NOT_FOUND', '检查记录不存在')
  deps = { ...deps, mode: run.report.mode || 'business', requestCache: new Map() }
  const stage = run.report.selectionStage || run.selection.stage
  const freshness = await checkRunFreshness(run, deps, { actor,
    candidateId: stage === 'flow' ? candidateId : undefined })
  if (!freshness.fresh) return markRunStale(db, run, freshness.reason)
  if (run.selection.confirmationState === 'complete' && run.selection.candidateId === candidateId) return run
  if (run.status !== 'needs_confirmation' || !['flow', 'source'].includes(stage)) {
    throw new CheckError(409, 'CHECK_NOT_CONFIRMABLE', '当前报告不需要流程确认')
  }
  const candidate = (run.report.flowCandidates || run.report.candidates || []).find(item => item.candidateId === candidateId)
  if (!candidate && !(stage === 'source' && candidateId === '__skip__')) {
    throw new CheckError(400, 'CANDIDATE_REQUIRED', '请从当前报告选择对应流程')
  }
  const claimed = await store.claimConfirmation(db, { roomKey, runId, candidateId, stage })
  if (!claimed) throw new CheckError(409, 'CONFIRMATION_IN_PROGRESS', '正在确认该报告，请稍后刷新')
  try {
    const snapshot = freshness.snapshot
    const chain = freshness.chain
    let result
    let selection = { ...claimed.selection, confirmationState: 'complete' }
    if (stage === 'flow') {
      result = await runFullCheck({ snapshot, nodeUid: run.nodeUid, chain, actor, deps: { ...deps, roomKey } })
      selection.chainCandidateId = candidateId
    } else if (candidateId === '__skip__') {
      const report = { ...run.report, selectionStage: null, candidates: [], flowCandidates: [],
        findings: run.report.findings.filter(item => !['CK-30','CK-32','CK-33','CK-34'].includes(item.ruleId)) }
      result = await searchForCandidates({ roomKey, actor, snapshot, chain, report, deps,
        startAt: Number(run.report.searchCursor || 0) + 1 })
    } else {
      if (candidate.kind !== 'flow') throw new CheckError(400, 'FLOW_REQUIRED', '材料候选无需确认成流程')
      const readSource = getProvider(deps, 'readSource')
      let body
      try { body = await readSource({ roomKey, sourceRef: candidate.sourceRef, actor, mode: deps.mode, requestCache: deps.requestCache }) }
      catch (_) { body = { status: 'error', complete: false } }
      if (body.status !== 'ok' || body.complete !== true || body.truncated || !hasFlowStructure(body.content)) {
        const report = { ...run.report, selectionStage: null, candidates: [], flowCandidates: [],
          findings: run.report.findings.filter(item => !['CK-30','CK-32','CK-33','CK-34'].includes(item.ruleId)),
          sourceStatuses: [...run.report.sourceStatuses, { scope: 'selected_flow', status: body.status || 'error',
            error: body.error || 'selected_flow_incomplete' }] }
        report.findings.push(sourceFinding('needs_info', candidate, '选定流程无法完整读取或不含完整 CPD，不能作为对照。'))
        result = await searchForCandidates({ roomKey, actor, snapshot, chain, report, deps,
          startAt: Number(run.report.searchCursor || 0) + 1 })
      } else {
        const extra = sourceEvidenceFromRead(body, candidate)
        if (candidate.version && candidate.complete && String(body.version || '') !== String(candidate.version)) {
          return markRunStale(db, claimed, '候选流程版本已变化，请重新检查后选择。')
        }
        result = await runFullCheck({ snapshot, nodeUid: run.nodeUid, chain, actor,
          deps: { ...deps, roomKey }, externalSources: [extra], includeSearch: false,
          sourceStatuses: run.report.sourceStatuses })
        selection = { ...selection, sourceRef: extra.sourceRef, sourceVersion: extra.version,
          sourceContentHash: sourceContentHash(extra.content), sourceKind: 'flow' }
      }
    }
    selection.stage = result.report.selectionStage || null
    if (!(result.report.findings || []).every(item => item.findingKey)) reportContract().decorateReport(result.report, { snapshot, chain, externalSources: result.readBodies || [], mode: deps.mode })
    reuseReviews(result.report, run, result.chainFingerprint || run.chainFingerprint)
    result.report.revision = Number(run.report.revision || 1) + 1
    if (selection.stage) { selection.candidateId = null; selection.confirmationState = 'pending' }
    const updated = await store.updateRun(db, { roomKey, runId, status: result.report.status,
      report: result.report, sourceRefs: result.sourceRefs, selection,
      chainFingerprint: result.chainFingerprint || run.chainFingerprint,
      mapVersion: mapVersionOf(snapshot), expectedSelectionState: 'processing', expectedRevision: reportRevision(run), confirmedAt: new Date().toISOString() })
    return updated || store.getRun(db, roomKey, runId)
  } catch (error) {
    const current = await store.getRun(db, roomKey, runId)
    if (current && current.selection.confirmationState === 'processing') {
      await store.updateRun(db, { roomKey, runId, status: 'failed',
        report: { ...current.report, status: 'failed', findings: current.report.findings.concat(
          sourceFinding('needs_info', null, '确认未完成，请重新检查。')) },
        selection: { ...current.selection, confirmationState: 'failed' }, expectedSelectionState: 'processing' })
    }
    throw error
  }
}

async function getCheck(input, deps = {}) {
  const roomKey = input && input.roomKey
  const runId = input && (input.runId || input.checkRunId)
  if (!roomKey || !runId) throw new CheckError(400, 'BAD_REQUEST', '缺少 roomKey 或检查记录 ID')
  const db = getDb(deps)
  await ensureInitialized(db)
  const run = await store.getRun(db, roomKey, runId)
  if (!run || run.status === 'stale') return run
  const freshness = await checkRunFreshness(run, deps, { actor: input.actor })
  if (freshness.fresh) return run
  const report = { ...run.report, status: 'stale', staleReason: freshness.reason, stale: true, revision: reportRevision(run) + 1,
    reviewDecisions: (run.report.reviewDecisions || []).map(entry => ({ ...entry, invalidated: true })) }
  return await store.updateRun(db, { roomKey, runId, status: 'stale', report, expectedRevision: reportRevision(run) }) || store.getRun(db, roomKey, runId)
}

async function listChecks(input, deps = {}) {
  const roomKey = input && input.roomKey
  if (!roomKey) throw new CheckError(400, 'BAD_REQUEST', '缺少 roomKey')
  const db = getDb(deps)
  await ensureInitialized(db)
  return store.listRuns(db, {
    roomKey,
    nodeUid: input.nodeUid,
    limit: input.limit,
    offset: input.offset
  })
}

function reportRevision(run) { return Number(run.report.revision || 1) }
function assertRevision(run, revision) {
  if (!Number.isInteger(revision) || revision < 1) throw new CheckError(400, 'REVISION_REQUIRED', '缺少有效的报告修订号')
  if (revision !== reportRevision(run)) throw new CheckError(409, 'REVISION_CONFLICT', '报告已更新，请刷新后再核对')
  if (run.selection.confirmationState === 'processing') throw new CheckError(409, 'CONFIRMATION_IN_PROGRESS', '正在确认流程，请稍后刷新')
}
function applyReview(report, entry) {
  const item = report.findings.find(finding => finding.findingKey === entry.findingKey)
  if (!item) return
  if (!item.machineStatus) item.machineStatus = item.status
  if (!item.machineCategory) item.machineCategory = item.category
  item.status = entry.decision === 'confirm' ? 'passed' : entry.decision === 'reject' ? 'failed' : item.machineStatus
  item.manualReview = entry.decision === 'revoke' ? null : entry
  reportContract().summarizeReport(report)
}
function reuseReviews(report, old, chainFingerprint) {
  const history = old.report.reviewDecisions || []
  report.reviewDecisions = history.map(entry => ({ ...entry, invalidated: true }))
  const latest = new Map(history.filter(entry => !entry.invalidated).map(entry => [entry.findingKey, entry]))
  if (report.mode === 'demo' || report.selectionStage) return
  for (const entry of latest.values()) {
    const item = report.findings.find(finding => finding.findingKey === entry.findingKey)
    const evidence = item && item.evidenceEntries || []
    const valid = item && item.reviewable && entry.chainFingerprint === chainFingerprint && entry.ruleVersion === rules.RULE_VERSION &&
      (entry.evidence || []).length && entry.evidence.every(saved => evidence.some(current => current.id === saved.id && current.complete && current.contentHash === saved.contentHash)) &&
      (item.requiredEvidenceIds || []).every(id => (entry.evidence || []).some(saved => saved.id === id))
    if (!valid) continue
    const reused = { ...entry, invalidated: false, reused: true }
    report.reviewDecisions = report.reviewDecisions.map(saved => saved.requestId === entry.requestId && saved.actorId === entry.actorId ? reused : saved)
    applyReview(report, reused)
  }
}

async function reviewCheck(input, deps = {}) {
  const { roomKey, runId, actor, findingKey, decision } = input
  const requestId = String(input.requestId || '').trim()
  const reason = String(input.reason || '').trim()
  assertIdentity(roomKey, actor, requestId)
  if (!['confirm', 'reject', 'revoke'].includes(decision) || !reason || reason.length > 2000) throw new CheckError(400, 'INVALID_REVIEW', '请选择核对结果并填写不超过2000字的说明')
  const ids = [...new Set(Array.isArray(input.evidenceIds) ? input.evidenceIds.map(String) : [])].sort()
  const payloadHash = digest(stableJson({ findingKey, decision, reason, ids }))
  const db = getDb(deps)
  await ensureInitialized(db)
  const initial = await store.getRun(db, roomKey, runId)
  if (!initial) throw new CheckError(404, 'CHECK_NOT_FOUND', '检查记录不存在')
  const fresh = await checkRunFreshness(initial, deps, { actor })
  if (!fresh.fresh) return markRunStale(db, initial, fresh.reason)
  return store.editRun(db, roomKey, runId, async (run, client) => {
    if (!run) throw new CheckError(404, 'CHECK_NOT_FOUND', '检查记录不存在')
    const history = run.report.reviewDecisions || []
    const duplicate = history.find(entry => entry.requestId === requestId && entry.actorId === actorId(actor))
    if (duplicate) {
      if (duplicate.payloadHash !== payloadHash) throw new CheckError(409, 'REQUEST_PAYLOAD_MISMATCH', '请求编号已用于不同的核对内容')
      return run
    }
    assertRevision(run, input.expectedRevision)
    if (run.status === 'stale' || run.report.mode === 'demo' || run.report.selectionStage) throw new CheckError(409, 'REVIEW_NOT_READY', '请先完成正式检查的链路和流程选择')
    const item = run.report.findings.find(finding => finding.findingKey === findingKey)
    const allowed = new Set(['CK-10', 'CK-11', 'CK-13', 'CK-27', 'CK-28', 'CK-29'])
    if (!item || !item.reviewable || !allowed.has(item.ruleId) || item.validationType !== 'manual_text_review' || (item.field && item.ruleId !== 'CK-29')) throw new CheckError(400, 'FINDING_NOT_REVIEWABLE', '该问题不能通过人工确认绕过')
    if (decision === 'revoke' && !item.manualReview) throw new CheckError(400, 'NO_REVIEW_TO_REVOKE', '该项尚无有效核对结果')
    const entries = item.evidenceEntries || []
    if (decision !== 'revoke' && (!ids.length || !(item.requiredEvidenceIds || []).length ||
      !(item.requiredEvidenceIds || []).every(id => ids.includes(id)) ||
      ids.some(id => !entries.some(entry => entry.id === id && entry.complete)))) {
      throw new CheckError(400, 'EVIDENCE_REQUIRED', '必须核对该项全部关联条目，且依据应完整可读取')
    }
    const entry = { requestId, payloadHash, findingKey, decision, reason,
      originalStatus: item.machineStatus || item.status, actorId: actorId(actor), actorName: actor && (actor.name || actor.username) || actorId(actor),
      originalJudgment: { ruleId: item.ruleId, title: item.title, status: item.machineStatus || item.status,
        category: item.machineCategory || item.category, severity: item.severity, message: item.message },
      at: new Date().toISOString(), chainFingerprint: run.chainFingerprint, ruleVersion: run.ruleVersion,
      evidence: entries.filter(value => ids.includes(value.id)).map(({ id, nodeUid, sourceId, contentHash, label, kind, quote }) => ({
        id, nodeUid, sourceId, contentHash, label, kind, excerpt: String(quote || '').slice(0, 600) })) }
    const report = structuredClone(run.report)
    report.reviewDecisions = [...history, entry]
    applyReview(report, entry)
    report.revision = reportRevision(run) + 1
    const updated = await store.updateRun(client, { roomKey, runId, report, status: report.status, expectedRevision: reportRevision(run) })
    if (!updated) throw new CheckError(409, 'REVISION_CONFLICT', '报告已更新，请刷新后再核对')
    return updated
  })
}

function registeredSource(run, sourceId) {
  const sources = [].concat(run.report.sources || [], run.report.selectedSources || [], run.report.materialCandidates || [], run.report.flowCandidates || [])
  return sources.find(source => source.sourceRef && (source.sourceId || sourceIdFor(source.sourceRef)) === sourceId)
}
async function readRegisteredSource(run, source, deps, actor) {
  const fresh = await checkRunFreshness(run, deps, { actor, skipSources: true })
  if (!fresh.fresh) throw new CheckError(409, 'CHECK_STALE', fresh.reason)
  const key = sourceKey(source.sourceRef)
  let body = (fresh.snapshot.sources || []).find(item => sourceKey(item.sourceRef) === key)
  if (!body && source.sourceRef.type === 'chain_node') {
    const node = chainUtils.nodesOf(fresh.snapshot)[source.sourceRef.nodeUid]
    if (node) {
      const content = `${chainUtils.nodeText(node)}\n${chainUtils.nodeNote(node)}\n${JSON.stringify(node.data || {})}`
      body = { title: chainUtils.nodeText(node), content, version: digest(content), status: 'ok', complete: true, provenance: { origin: 'business' } }
    }
  }
  if (!body) {
    const read = getProvider(deps, 'readSource')
    if (typeof read !== 'function') return { status: 'unavailable', complete: false, content: '', error: 'provider_not_configured' }
    try { body = await read({ roomKey: run.roomKey, sourceRef: source.sourceRef, actor, mode: run.report.mode || 'business', requestCache: deps.requestCache }) }
    catch (_) { body = { status: 'unavailable', complete: false, content: '', error: 'source_read_failed' } }
  }
  return body
}
async function getCheckSource(input, deps = {}) {
  const db = getDb(deps)
  const run = await store.getRun(db, input.roomKey, input.runId)
  if (!run) throw new CheckError(404, 'CHECK_NOT_FOUND', '检查记录不存在')
  const source = registeredSource(run, input.sourceId)
  if (!source) throw new CheckError(404, 'SOURCE_NOT_REGISTERED', '来源未登记在当前报告中')
  const body = await readRegisteredSource(run, source, deps, input.actor)
  const unchanged = (!source.contentHash || sourceContentHash(body.content) === source.contentHash) && (!source.version || String(body.version || '') === String(source.version))
  return { sourceId: input.sourceId, title: body.title || source.title, path: body.path || source.pathText || source.path,
    provenance: body.provenance || source.provenance || { origin: 'unknown' },
    status: body.status || 'unavailable', complete: body.complete === true && !body.truncated && String(body.content || '').length <= 200000, truncated: !!body.truncated || String(body.content || '').length > 200000,
    content: String(body.content || '').slice(0, 200000), version: body.version || '', contentHash: sourceContentHash(body.content),
    changed: !unchanged, error: body.error || '', role: source.role || source.sourceRole || 'reference' }
}
async function retryCheckSource(input, deps = {}) {
  const { roomKey, runId, actor, sourceId } = input
  const requestId = String(input.requestId || '').trim()
  assertIdentity(roomKey, actor, requestId)
  const db = getDb(deps)
  const run = await store.getRun(db, roomKey, runId)
  if (!run) throw new CheckError(404, 'CHECK_NOT_FOUND', '检查记录不存在')
  const previousRetry = (run.report.sourceRetries || []).find(entry => entry.requestId === requestId && entry.actorId === actorId(actor))
  if (previousRetry) {
    if (previousRetry.sourceId !== sourceId) throw new CheckError(409, 'REQUEST_ID_CONFLICT', '请求 ID 已用于其他来源')
    return run
  }
  assertRevision(run, input.expectedRevision)
  const source = registeredSource(run, sourceId)
  if (!source) throw new CheckError(404, 'SOURCE_NOT_REGISTERED', '来源未登记在当前报告中')
  const fresh = await checkRunFreshness(run, deps, { actor, skipSources: true })
  if (!fresh.fresh) return markRunStale(db, run, fresh.reason)
  if (run.report.selectionStage === 'flow') throw new CheckError(409, 'CHAIN_REQUIRED', '请先选择检查链路')
  const retryDeps = { ...deps, requestCache: new Map() }
  let body = await readRegisteredSource(run, source, retryDeps, actor)
  if (source.sourceRef.type === 'wiki_compiler' && ['wiki_chunk_not_current', 'wiki_provenance_changed'].includes(body.error)) {
    const search = getProvider(retryDeps, 'searchSources')
    const read = getProvider(retryDeps, 'readSource')
    if (typeof search === 'function' && typeof read === 'function') {
      try {
        const refreshed = await search({ roomKey, actor, query: source.sourceRef.query, scope: 'wiki',
          mode: run.report.mode || 'business', requestCache: retryDeps.requestCache })
        const sameSource = (refreshed.candidates || []).find(item => item.sourceRef && sourceIdFor(item.sourceRef) === sourceIdFor(source.sourceRef))
        if (sameSource) body = await read({ roomKey, actor, sourceRef: sameSource.sourceRef,
          mode: run.report.mode || 'business', requestCache: retryDeps.requestCache })
      } catch (_) { /* Preserve the typed original read failure. */ }
    }
  }
  const snapshot = fresh.snapshot
  if (body && source.sourceRef.type === 'attachment') {
    snapshot.sources = (snapshot.sources || []).map(item => sourceKey(item.sourceRef) === sourceKey(source.sourceRef) ? { ...body, sourceRef: source.sourceRef } : item)
  }
  const selectedWasRetried = run.selection.sourceRef && sourceIdFor(run.selection.sourceRef) === sourceId
  const selectedStillValid = !selectedWasRetried || (body.status === 'ok' && body.complete === true && !body.truncated &&
    String(body.version || '') === String(run.selection.sourceVersion || '') && sourceContentHash(body.content) === run.selection.sourceContentHash)
  const reference = selectedWasRetried && selectedStillValid ? { ...body, sourceRef: source.sourceRef, kind: 'flow' } : null
  const built = await runFullCheck({ snapshot, nodeUid: run.nodeUid, chain: fresh.chain, actor,
    deps: { ...deps, roomKey, mode: run.report.mode || 'business', requestCache: new Map() },
    externalSources: reference ? [reference] : [], includeSearch: false })
  const report = built.report
  // Reuse registered metadata; a single-source retry never queries other sources.
  const retried = sourceMetadata({ ...source, ...body, sourceRef: body.sourceRef || source.sourceRef }, sourceContextFor(snapshot, fresh.chain))
  report.sources = dedupeSources([...(run.report.sources || []).filter(item => sourceIdFor(item.sourceRef) !== sourceId),
    ...(report.sources || []).filter(item => sourceIdFor(item.sourceRef) !== sourceId), retried])
  const priorStatus = (run.report.sourceStatuses || []).find(item => item.sourceId === sourceId || item.sourceRef && sourceIdFor(item.sourceRef) === sourceId)
  report.sourceStatuses = (run.report.sourceStatuses || []).filter(item => item.sourceId !== sourceId && !(item.sourceRef && sourceIdFor(item.sourceRef) === sourceId))
  report.sourceStatuses.push({ scope: priorStatus && priorStatus.scope || 'chain', sourceId, sourceRef: source.sourceRef,
    candidateId: source.candidateId || sourceId, operation: 'read', title: body.title || source.title, status: body.status || 'unavailable',
    error: body.error || (body.truncated ? 'truncated' : body.complete !== true ? 'incomplete' : '') })
  report.flowCandidates = (run.report.flowCandidates || []).map(item => sourceIdFor(item.sourceRef) === sourceId ?
    { ...item, ...retried, referenceDetails: body.referenceDetails || item.referenceDetails } : item)
  report.selectionStage = run.report.selectionStage || null
  report.searchCursor = run.report.searchCursor
  if (!selectedStillValid) {
    report.selectionStage = 'source'
    if (!report.flowCandidates.some(item => sourceIdFor(item.sourceRef) === sourceId)) report.flowCandidates.push({
      ...source, ...retried, kind: 'flow', candidateId: run.selection.candidateId || sourceId,
      referenceDetails: body.referenceDetails, matchReason: '原参考来源已变化，请重新读取并确认适用关系。' })
  } else if (run.report.referenceComparison && !reference) {
    report.referenceComparison = structuredClone(run.report.referenceComparison)
    report.selectedSources = structuredClone(run.report.selectedSources || [])
  }
  report.candidates = report.flowCandidates
  if (report.selectionStage) report.status = 'needs_confirmation'
  report.materialCandidates = [...new Map([...(report.materialCandidates || []),
    ...(run.report.materialCandidates || []).filter(item => item.source !== 'chain' && sourceIdFor(item.sourceRef) !== sourceId)]
    .map(item => [`${item.candidateId}:${item.nodeUid}:${item.field}`, item])).values()]
  if (body.status === 'ok' && body.complete === true && !body.truncated) {
    for (const item of report.findings.filter(isMissingFinding)) {
      const match = materialMatchFor(item, body.content)
      if (match) report.materialCandidates.push({ ...source, ...retried, candidateId: `${sourceId}:${item.findingKey}`, kind: 'material',
        field: item.field, nodeUid: item.nodeUid, term: match.term, quote: match.quote, matchReason: match.reason })
    }
  }
  report.findings = report.findings.filter(item => !['CK-30', 'CK-32', 'CK-33', 'CK-34'].includes(item.ruleId))
  report.findings.push(...rules.sourceSearchFindings(report.sourceStatuses, report.findings.filter(isMissingFinding)))
  reportContract().decorateReport(report, { snapshot, chain: fresh.chain, externalSources: body.complete ? [{ ...body, sourceRef: source.sourceRef }] : [], mode: run.report.mode || 'business' })
  reuseReviews(report, run, built.chainFingerprint)
  report.revision = reportRevision(run) + 1
  report.sourceRetries = [...(run.report.sourceRetries || []), { requestId, sourceId, actorId: actorId(actor), at: new Date().toISOString(), status: body.status }]
  return store.editRun(db, roomKey, runId, async (latest, client) => {
    if (!latest) throw new CheckError(404, 'CHECK_NOT_FOUND', '检查记录不存在')
    if ((latest.report.sourceRetries || []).some(entry => entry.requestId === requestId && entry.actorId === actorId(actor))) return latest
    assertRevision(latest, input.expectedRevision)
    const selection = selectedStillValid ? latest.selection : { chainCandidateId: latest.selection.chainCandidateId, stage: report.selectionStage || null }
    const updated = await store.updateRun(client, { roomKey, runId, report, status: report.status, sourceRefs: report.sources, selection, chainFingerprint: built.chainFingerprint, mapVersion: mapVersionOf(snapshot), expectedRevision: reportRevision(latest) })
    if (!updated) throw new CheckError(409, 'REVISION_CONFLICT', '报告已更新，请刷新后重试')
    return updated
  })
}

async function markRunStale(db, run, message) {
  const report = { ...run.report, status: 'stale', revision: reportRevision(run) + 1, staleAt: new Date().toISOString(), staleReason: message }
  report.findings = (report.findings || []).concat(rules.finding({
    ruleId: 'CK-30', title: '检查记录过期', status: 'needs_info', severity: 'blocker', message
  }))
  reportContract().summarizeReport(report)
  await store.updateRun(db, { roomKey: run.roomKey, runId: run.runId, status: 'stale', report, expectedRevision: reportRevision(run) })
  throw new CheckError(409, 'CHECK_STALE', message)
}

module.exports = {
  CheckError,
  RULE_VERSION: rules.RULE_VERSION,
  RULE_REGISTRY: rules.RULE_REGISTRY,
  initSchema,
  createCheck,
  confirmCheck,
  getCheck,
  listChecks,
  reviewCheck,
  getCheckSource,
  retryCheckSource,
  resolveCheckChain: chainUtils.resolveCheckChain,
  fingerprintChain: chainUtils.fingerprintChain,
  _internals: {
    actorId,
    runFullCheck,
    summarizeStatus,
    summaryOf,
    sourceMetadata,
    sourceIdentity,
    dedupeSources,
    buildQuery,
    materialMatchFor,
    sanitizeCandidate,
    hasFlowStructure,
    searchForCandidates
  }
}
