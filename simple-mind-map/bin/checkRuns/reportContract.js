'use strict'

const chainUtils = require('./chain')
const { sourceIdFor, findingKeyFor, stableJson, digest } = require('./identity')

const CATEGORIES = Object.freeze([
  'structure', 'missing', 'review', 'source_error', 'hint', 'passed',
  'not_applicable', 'auxiliary'
])
const STRUCTURE_RULES = new Set(['CK-06', 'CK-12', 'CK-20', 'CK-21'])
const REVIEWABLE_RULES = new Set(['CK-10', 'CK-27', 'CK-28', 'CK-11', 'CK-13', 'CK-29'])
const SOURCE_ERROR_RULES = new Set(['CK-30', 'CK-33', 'CK-34'])
const UNRESOLVED_STATUSES = new Set(['failed', 'blocked', 'needs_info', 'needs_supplement', 'needs_confirmation'])
const FIELD_LABELS = Object.freeze({
  targetValue: '目标值', frequency: '频率', inputs: '输入源', criterion: '判据',
  owner: '责任人', outputs: '产物', remediation: '未达标处置', reference: '材料来源'
})

function rawNodeText(node) {
  if (!node) return ''
  const data = node.data && typeof node.data === 'object' ? node.data : {}
  return String(node.text != null ? node.text : data.text != null ? data.text : node.title || '')
}

function rawNodeNote(node) {
  if (!node) return ''
  const data = node.data && typeof node.data === 'object' ? node.data : {}
  return String(node.note != null ? node.note : data.note || '')
}

function visibleText(value) {
  return String(value == null ? '' : value)
    .replace(/<(?:br\s*\/?|\/(?:p|li|div))\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function statusComplete(source) {
  if (!source || source.complete === false || source.truncated) return false
  const status = String(source.status || '').toLowerCase()
  return !status || status === 'ok' || status === 'ready'
}

function fieldString(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return stableJson(value)
}

function evidenceEntry({ kind, nodeUid = null, sourceRef = null, sourceId = '', label, content, quote, position = 0, complete = true }) {
  const original = String(content == null ? '' : content)
  const visibleContent = visibleText(original)
  const visibleQuote = visibleText(quote)
  if (!visibleQuote || !visibleContent.includes(visibleQuote)) return null
  const resolvedSourceId = sourceId || sourceIdFor(sourceRef || { type: 'chain_node', nodeUid })
  const contentHash = digest(original)
  const id = `evidence-${digest(stableJson([
    resolvedSourceId, kind, nodeUid, String(position), contentHash, visibleQuote
  ])).slice(0, 24)}`
  return {
    id, kind, nodeUid, sourceId: resolvedSourceId, label: String(label || ''),
    sourceRef, position: String(position), contentSummary: visibleContent.slice(0, 600),
    quote: visibleQuote, contentHash, complete: Boolean(complete), verified: true
  }
}

function nodeEntries(snapshot, uid, roleLabel = '') {
  const nodes = chainUtils.nodesOf(snapshot)
  const node = nodes[uid]
  if (!node) return []
  const title = chainUtils.nodeText(node) || String(uid)
  const sourceRef = { type: 'chain_node', roomKey: snapshot && snapshot.roomKey || '', nodeUid: String(uid) }
  const sourceId = sourceIdFor(sourceRef)
  const text = rawNodeText(node)
  const note = rawNodeNote(node)
  const entries = []
  if (visibleText(text)) {
    const entry = evidenceEntry({
      kind: 'node_text', nodeUid: String(uid), sourceRef, sourceId,
      label: [roleLabel, '节点正文', title].filter(Boolean).join(' · '),
      content: text, quote: text, complete: node.textComplete !== false && node.complete !== false
    })
    if (entry) entries.push(entry)
  }
  if (visibleText(note)) {
    const entry = evidenceEntry({
      kind: 'node_note', nodeUid: String(uid), sourceRef, sourceId,
      label: [roleLabel, '节点备注', title].filter(Boolean).join(' · '),
      content: note, quote: note, complete: node.noteComplete !== false && node.complete !== false
    })
    if (entry) entries.push(entry)
  }
  return entries
}

function nodeFieldEntry(snapshot, uid, field) {
  const nodes = chainUtils.nodesOf(snapshot)
  const node = nodes[uid]
  const data = node && node.data && typeof node.data === 'object' ? node.data : {}
  const value = fieldString(data[field])
  if (!value.trim()) return null
  const sourceRef = { type: 'chain_node', roomKey: snapshot && snapshot.roomKey || '', nodeUid: String(uid) }
  return evidenceEntry({
    kind: 'node_field', nodeUid: String(uid), sourceRef,
    label: `节点明确字段：${FIELD_LABELS[field] || field}`,
    content: value, quote: value, position: field,
    complete: node.complete !== false
  })
}

function attachmentIds(node) {
  const data = node && node.data && typeof node.data === 'object' ? node.data : {}
  return [].concat(data.attachments || [], data.attachmentId || [], data.attachmentIds || [])
    .map(item => typeof item === 'object' ? item.id || item.attachmentId || item.uid : item)
    .filter(value => value != null && String(value).trim())
    .map(String)
}

function boundSources(snapshot, chain, nodeUids) {
  const nodes = chainUtils.nodesOf(snapshot)
  const chainUids = new Set([...(chain && chain.nodeUids || []), ...(chain && chain.auditNodeUids || [])].map(String))
  const wantedNodes = new Set((nodeUids || []).map(String))
  const all = Array.isArray(snapshot && snapshot.sources) ? snapshot.sources : []
  const output = []
  for (const source of all) {
    if (!source || typeof source !== 'object') continue
    const ref = source.sourceRef && typeof source.sourceRef === 'object' ? source.sourceRef : {}
    const type = String(ref.type || source.type || source.kind || '').toLowerCase()
    const ownerUid = String(source.nodeUid || ref.nodeUid || '')
    if (!ownerUid || !wantedNodes.has(ownerUid) || !chainUids.has(ownerUid)) continue
    let linked = false
    if (type === 'attachment' || type === 'file_attachment') {
      const node = nodes[ownerUid]
      const id = String(ref.id || ref.attachmentId || source.attachmentId || '')
      linked = ownerUid === String(source.nodeUid || ref.nodeUid || '') &&
        (!id || attachmentIds(node).includes(id))
    } else if (!type && !ref.id && !ref.attachmentId && String(source.nodeUid || '') === ownerUid) {
      // Compatibility for existing snapshots that carry the owning node but
      // not the attachment's explicit type/id.
      linked = true
    } else {
      const node = nodes[ownerUid]
      const data = node && node.data && typeof node.data === 'object' ? node.data : {}
      const refs = Array.isArray(data.cpdCheckReferences) ? data.cpdCheckReferences : []
      linked = refs.some(item => item && item.sourceRef &&
        stableJson(item.sourceRef) === stableJson(ref) && item.field &&
        ['reference', 'inputs', 'dataSource'].includes(item.field) &&
        source.linkedReference === true &&
        String(item.sourceVersion || '') === String(source.version || '') &&
        String(item.quote || item.referenceQuote || '').trim() &&
        String(source.content || '').includes(String(item.quote || item.referenceQuote)))
    }
    if (linked) output.push(source)
  }
  return output
}

function sourceEntry(source, label, quote, position = 0) {
  const ref = source.sourceRef && typeof source.sourceRef === 'object' ? source.sourceRef : {
    type: source.source || source.kind || 'source', nodeUid: source.nodeUid || null,
    id: source.id || source.attachmentId || null
  }
  const sourceId = sourceIdFor(ref)
  return evidenceEntry({
    kind: String(ref.type || source.source || source.kind || 'source'),
    nodeUid: source.nodeUid || ref.nodeUid || null,
    sourceRef: ref, sourceId, label,
    content: source.content, quote, position,
    complete: statusComplete(source)
  })
}

function findTextExcerpt(content, term) {
  const text = visibleText(content)
  const needle = visibleText(term)
  if (!text) return ''
  const index = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1
  if (index < 0) return text.slice(0, 360)
  const start = Math.max(0, index - 100)
  const end = Math.min(text.length, index + needle.length + 180)
  return text.slice(start, end)
}

function relatedNodes(finding, data, chain) {
  const set = new Set()
  const add = items => (items || []).forEach(item => item && item.uid && set.add(String(item.uid)))
  switch (finding.ruleId) {
    case 'CK-07': add(data.planNodes); break
    case 'CK-09': add(data.dNodes); break
    case 'CK-10': add(data.dNodes); add(data.steps); break
    case 'CK-11': add(data.checkNodes); add(data.dNodes); add(data.steps); break
    case 'CK-13': add(data.planNodes); add(data.dNodes); break
    case 'CK-27':
    case 'CK-28': add(data.checkNodes); add(data.planNodes); break
    case 'CK-29': if (finding.nodeUid) set.add(String(finding.nodeUid)); break
    default: if (finding.nodeUid) set.add(String(finding.nodeUid))
  }
  if (!set.size && finding.nodeUid) set.add(String(finding.nodeUid))
  return [...set].filter(uid => chainUtils.nodesOf(data.snapshot || {})[uid])
}

function addUnique(entries, entry) {
  if (entry && !entries.some(item => item.id === entry.id)) entries.push(entry)
}

function entriesForFinding(finding, snapshot, chain, data, nodes) {
  const entries = []
  const addNodes = (items, roleLabel = '') => {
    for (const item of items || []) {
      if (!item || !item.uid) continue
      nodeEntries(snapshot, item.uid, roleLabel).forEach(entry => addUnique(entries, entry))
      if (finding.field) addUnique(entries, nodeFieldEntry(snapshot, item.uid, finding.field))
    }
  }

  if (finding.ruleId === 'CK-27' || finding.ruleId === 'CK-28') {
    addNodes(data.checkNodes, 'C')
    addNodes(data.planNodes, 'P')
  } else if (finding.ruleId === 'CK-10') {
    addNodes(data.dNodes, 'D')
    addNodes(data.steps, '执行步骤')
  } else if (finding.ruleId === 'CK-11' && /closure-review$/.test(String(finding.checkKey || ''))) {
    const c = data.checkNodes.filter(item => item.uid === finding.nodeUid)
    addNodes(c.length ? c : data.checkNodes, 'C')
    addNodes(data.dNodes, 'D')
    addNodes(data.steps, '执行步骤')
  } else if (finding.ruleId === 'CK-13' && finding.status === 'needs_info' && /进度内外/.test(String(finding.message || ''))) {
    addNodes(data.planNodes.filter(item => /进度内|进度外/.test(`${item.text || ''}\n${item.note || ''}`)), 'P')
    addNodes(data.dNodes.filter(item => /进度内|进度外/.test(`${item.text || ''}\n${item.note || ''}`)), 'D')
  } else {
    const uid = finding.nodeUid && String(finding.nodeUid)
    if (uid && nodes[uid]) {
      const role = chainUtils.roleOf(chainUtils.nodeText(nodes[uid])) || ''
      addNodes([{ uid }], role)
    } else if (finding.ruleId === 'CK-09') addNodes(data.dNodes, 'D')
  }

  const related = relatedNodes(finding, { ...data, snapshot }, chain)
  const attached = boundSources(snapshot, chain, related)
  const directRef = finding.sourceRef && sourceIdFor(finding.sourceRef)
  const relevantSources = attached.filter(source => !directRef || sourceIdFor(source.sourceRef || {}) === directRef)
  if (finding.ruleId === 'CK-29' && finding.nodeUid) {
    addUnique(entries, nodeFieldEntry(snapshot, String(finding.nodeUid), 'inputs'))
  }
  if (finding.ruleId === 'CK-29' || finding.sourceRef) {
    const needed = String(finding.requiredQuote || finding.quote || '').trim()
    for (const source of relevantSources) {
      const excerpt = findTextExcerpt(source.content || '', needed)
      const entry = sourceEntry(source, `已绑定材料：${String(source.title || source.name || '附件')}`, excerpt,
        visibleText(source.content || '').toLowerCase().indexOf(visibleText(needed).toLowerCase()))
      addUnique(entries, entry)
    }
  }

  if (finding.quote) {
    let matched = false
    for (const uid of related) {
      const node = nodes[uid]
      if (!node) continue
      const text = rawNodeText(node)
      if (visibleText(text).includes(visibleText(finding.quote))) {
        const role = chainUtils.roleOf(chainUtils.nodeText(node)) || ''
        addUnique(entries, evidenceEntry({
          kind: 'node_text', nodeUid: uid,
          sourceRef: { type: 'chain_node', roomKey: snapshot && snapshot.roomKey || '', nodeUid: uid },
          label: [role, '节点正文', chainUtils.nodeText(node)].filter(Boolean).join(' · '),
          content: text, quote: finding.quote, complete: node.complete !== false
        }))
        matched = true
        break
      }
      const note = rawNodeNote(node)
      if (note && visibleText(note).includes(visibleText(finding.quote))) {
        addUnique(entries, evidenceEntry({
          kind: 'node_note', nodeUid: uid,
          sourceRef: { type: 'chain_node', roomKey: snapshot && snapshot.roomKey || '', nodeUid: uid },
          label: `节点备注 · ${chainUtils.nodeText(node) || uid}`,
          content: note, quote: finding.quote, complete: node.complete !== false
        }))
        matched = true
        break
      }
    }
    if (!matched && relevantSources.length) {
      for (const source of relevantSources) {
        const content = String(source.content || '')
        if (!visibleText(content).includes(visibleText(finding.quote))) continue
        addUnique(entries, sourceEntry(source, `已绑定材料：${String(source.title || source.name || '附件')}`,
          finding.quote, visibleText(content).toLowerCase().indexOf(visibleText(finding.quote).toLowerCase())))
        matched = true
        break
      }
    }
  }

  return { entries, related, attached }
}

function sourceErrorInfo(report) {
  const failedStatuses = (Array.isArray(report.sourceStatuses) ? report.sourceStatuses : []).filter(item => {
    const code = String(item && item.status || '').toLowerCase()
    return new Set(['unavailable', 'forbidden', 'error', 'failed', 'parse_failed', 'not_connected', 'no_permission', 'not_found', 'conflict', 'partial', 'incomplete', 'truncated']).has(code) || Boolean(String(item && item.error || '').trim())
  })
  const groups = new Map()
  for (const item of failedStatuses) {
    const ref = item.sourceRef || item.ref || null
    const sourceId = sourceIdFor(ref || { type: item.scope || 'source', id: item.candidateId || item.sourceId || item.error || item.status })
    const key = sourceId
    const entry = groups.get(key) || {
      sourceId, scope: String(item.scope || ''), candidateId: String(item.candidateId || ''),
      title: String(item.title || item.name || ''), status: String(item.status || ''),
      error: String(item.error || ''), sourceRef: ref && typeof ref === 'object' ? ref : null,
      path: String(item.path || item.uri || ''), version: String(item.version || ''), statuses: []
    }
    const signature = `${item.status || ''}|${item.error || ''}`
    if (!entry.statuses.includes(signature)) entry.statuses.push(signature)
    if (!entry.error && item.error) entry.error = String(item.error)
    if (!entry.status && item.status) entry.status = String(item.status)
    groups.set(key, entry)
  }
  return [...groups.values()]
}

function findingCategory(finding, incompleteCoverage) {
  if (finding.ruleId === 'CK-32') return 'auxiliary'
  if (finding.display === false) return 'auxiliary'
  if (finding.status === 'passed') return 'passed'
  if (finding.status === 'not_applicable') return 'not_applicable'
  if (SOURCE_ERROR_RULES.has(finding.ruleId) || finding.sourceErrors && finding.sourceErrors.length || incompleteCoverage) return 'source_error'
  if (STRUCTURE_RULES.has(finding.ruleId)) return 'structure'
  if (finding.status === 'needs_supplement') return 'missing'
  if (finding.status === 'needs_info' || finding.status === 'needs_confirmation' || finding.status === 'failed' || finding.status === 'blocked') {
    if (REVIEWABLE_RULES.has(finding.ruleId) || finding.severity === 'blocker') return 'review'
    return 'hint'
  }
  return 'hint'
}

function allowReview(finding, entries, requiredEvidenceIds, completeCoverage) {
  if (!REVIEWABLE_RULES.has(finding.ruleId) || !completeCoverage || !requiredEvidenceIds.length) return false
  if (!requiredEvidenceIds.every(id => entries.some(entry => entry.id === id && entry.complete))) return false
  const review = finding.manualReview || finding.review
  const machineStatus = finding.machineStatus || review && review.machineStatus || finding.status
  if (machineStatus === 'needs_supplement' || machineStatus === 'failed' || machineStatus === 'blocked') return false
  if (finding.status === 'passed') return Boolean(review && ['pass', 'passed', 'confirm', '符合'].includes(review.decision || review.status))
  if (!['needs_info', 'needs_confirmation'].includes(machineStatus)) return false
  if (finding.ruleId === 'CK-10') return entries.some(item => item.kind === 'node_text' && /^D\b|D ·/.test(item.label))
  if (finding.ruleId === 'CK-27' || finding.ruleId === 'CK-28') {
    const cNodes = new Set(entries.filter(item => item.label.startsWith('C ·')).map(item => item.nodeUid))
    const pNodes = new Set(entries.filter(item => item.label.startsWith('P ·')).map(item => item.nodeUid))
    return cNodes.size > 0 && pNodes.size > 0
  }
  if (finding.ruleId === 'CK-11') return /closure-review$/.test(String(finding.checkKey || ''))
  if (finding.ruleId === 'CK-13') return /进度内外/.test(String(finding.message || ''))
  if (finding.ruleId === 'CK-29') {
    const review = finding.manualReview || finding.review
    const machineStatus = finding.machineStatus || review && review.machineStatus || finding.status
    const expectedSourceId = finding.sourceRef ? sourceIdFor(finding.sourceRef) : ''
    const needed = visibleText(finding.requiredQuote || '').toLowerCase()
    const matchedSource = expectedSourceId && entries.some(item => item.sourceId === expectedSourceId &&
      item.complete && !['node_text', 'node_note', 'node_field'].includes(item.kind) &&
      needed && item.quote.toLowerCase().includes(needed))
    return finding.field === 'reference' && machineStatus === 'needs_info' &&
      /已完整读取，需核验与此 D 输入的对应关系/.test(String(finding.message || '')) && Boolean(matchedSource)
  }
  return false
}

function buildRequiredEvidence(finding, entries, data) {
  let targets = []
  if (finding.ruleId === 'CK-27' || finding.ruleId === 'CK-28') {
    targets = [...data.checkNodes.map(item => String(item.uid)), ...data.planNodes.map(item => String(item.uid))]
    const textNodes = new Set(entries.filter(item => item.kind === 'node_text' && item.complete).map(item => String(item.nodeUid)))
    if (!data.checkNodes.length || !data.planNodes.length || targets.some(uid => !textNodes.has(uid))) return []
  } else if (finding.ruleId === 'CK-10') {
    targets = [...data.dNodes.map(item => String(item.uid)), ...data.steps.map(item => String(item.uid))]
    const textNodes = new Set(entries.filter(item => item.kind === 'node_text' && item.complete).map(item => String(item.nodeUid)))
    if (!data.dNodes.length || targets.some(uid => !textNodes.has(uid))) return []
  } else if (finding.ruleId === 'CK-11' && /closure-review$/.test(String(finding.checkKey || ''))) {
    targets = [String(finding.nodeUid || ''), ...data.dNodes.map(item => String(item.uid)), ...data.steps.map(item => String(item.uid))].filter(Boolean)
    const textNodes = new Set(entries.filter(item => item.kind === 'node_text' && item.complete).map(item => String(item.nodeUid)))
    const combined = entries.filter(item => targets.includes(String(item.nodeUid))).map(item => item.quote).join('\n')
    if (!data.dNodes.length || targets.some(uid => !textNodes.has(uid) && !entries.some(item => item.nodeUid === uid && item.kind === 'node_note' && item.complete)) ||
      !/(?:判据|检查标准|验收标准|完成标准|达标|合格|符合|不低于|不少于|不超过|≤|≥)/.test(combined) ||
      !/(?:未达标|不达标|不通过|不符合|异常|偏差)/.test(combined) ||
      !/(?:时|后|则|应|暂停|调整|返工|重新|升级|通知|处理|补充|纠正|复核)/.test(combined)) return []
  } else if (finding.ruleId === 'CK-13' && /进度内外/.test(String(finding.message || ''))) {
    targets = entries.filter(item => item.kind === 'node_text' || item.kind === 'node_note').map(item => String(item.nodeUid || ''))
    const combined = entries.filter(item => targets.includes(String(item.nodeUid))).map(item => item.quote).join('\n')
    if (!combined.includes('进度内') || !combined.includes('进度外')) return []
  } else if (finding.ruleId === 'CK-29' && finding.field === 'reference') {
    targets = [String(finding.nodeUid || '')].filter(Boolean)
    const hasInput = entries.some(item => item.nodeUid === targets[0] && item.kind === 'node_field' && item.label === '节点明确字段：输入源' && item.complete) ||
      entries.some(item => item.nodeUid === targets[0] && ['node_text', 'node_note'].includes(item.kind) &&
        visibleText(item.quote).toLowerCase().includes(visibleText(finding.requiredQuote || '').toLowerCase()))
    if (!targets.length || !hasInput) return []
    const expectedSourceId = finding.sourceRef ? sourceIdFor(finding.sourceRef) : ''
    const sources = entries.filter(item => item.sourceId === expectedSourceId &&
      !['node_text', 'node_note', 'node_field'].includes(item.kind))
    const needed = visibleText(finding.requiredQuote || '').toLowerCase()
    if (!finding.sourceRef || !needed || !sources.some(item => item.complete && item.quote.toLowerCase().includes(needed))) return []
    return [...new Set([
      ...entries.filter(item => targets.includes(String(item.nodeUid)) &&
        (['node_text', 'node_note'].includes(item.kind) || item.kind === 'node_field' && item.label === '节点明确字段：输入源')).map(item => item.id),
      ...sources.map(item => item.id)
    ])]
  }
  if (!targets.length) return []
  return [...new Set(entries.filter(item => targets.includes(String(item.nodeUid)) &&
    ['node_text', 'node_note', 'node_field'].includes(item.kind)).map(item => item.id))]
}

function mergeSourceErrors(report, findings) {
  const errors = sourceErrorInfo(report)
  const ck30 = findings.find(item => item.ruleId === 'CK-30')
  const issueRules = findings.filter(item => SOURCE_ERROR_RULES.has(item.ruleId) && UNRESOLVED_STATUSES.has(item.status))
  const hasSourceIssue = errors.length > 0 || issueRules.some(item => item.ruleId === 'CK-30')
  if (!hasSourceIssue || !ck30) return
  ck30.sourceErrors = errors
  ck30.relatedRuleIds = [...new Set(['CK-30', ...issueRules.filter(item => item.ruleId !== 'CK-30').map(item => item.ruleId)])]
  if (errors.length && ck30.status === 'passed') {
    ck30.status = 'needs_info'
    ck30.message = '至少一个已登记来源未完成读取；读取失败不表示资料不存在，请按来源状态处理。'
  }
  ck30.category = 'source_error'
  for (const item of issueRules) {
    if (item === ck30) continue
    item.mergedIntoFindingKey = ck30.findingKey
    item.relatedRuleIds = ck30.relatedRuleIds.slice()
    item.display = false
    item.category = 'auxiliary'
  }
}

function summarizeReport(report) {
  const target = report && typeof report === 'object' ? report : {}
  const findings = Array.isArray(target.findings) ? target.findings : []
  const categories = Object.fromEntries(CATEGORIES.map(category => [category, 0]))
  for (const item of findings) {
    const incomplete = item.coverage && item.coverage.complete === false &&
      Array.isArray(item.coverage.incompleteSourceIds) && item.coverage.incompleteSourceIds.length > 0
    const category = findingCategory(item, incomplete)
    item.category = category
    item.blocking = item.severity === 'blocker' && UNRESOLVED_STATUSES.has(item.status) && item.display !== false && category !== 'auxiliary'
    categories[category] += 1
  }
  const counted = findings.filter(item => item.ruleId !== 'CK-32' && item.display !== false && item.category !== 'auxiliary')
  const unresolved = counted.filter(item => UNRESOLVED_STATUSES.has(item.status))
  const actionable = ['structure', 'missing', 'review', 'source_error', 'hint']
    .reduce((total, category) => total + categories[category], 0)
  const summary = {
    actionable,
    categories,
    blockers: unresolved.filter(item => item.blocking != null ? item.blocking : item.severity === 'blocker').length,
    passed: findings.filter(item => item.status === 'passed' && item.display !== false).length,
    notApplicable: findings.filter(item => item.status === 'not_applicable' && item.display !== false).length,
    needsSupplement: unresolved.filter(item => item.status === 'needs_supplement').length,
    warnings: unresolved.filter(item => item.severity === 'warning').length
  }
  target.summary = summary
  if (target.provenanceMode === 'demo' || target.provenanceMode === 'demo_validation' ||
      target.mode === 'demo' || target.mode === 'demo_validation') {
    target.provenanceMode = 'demo'
    target.formalPassEligible = false
    for (const item of findings) {
      item.provenanceMode = 'demo'
      item.formalPassEligible = false
    }
    if (target.status === 'passed') target.status = 'needs_confirmation'
    target.statusReason = 'demo_only'
  } else if (target.status !== 'stale' && findings.length) {
    target.formalPassEligible = true
    if (!target.selectionStage) {
      if (findings.some(item => item.status === 'failed' && item.severity === 'blocker' && item.display !== false)) target.status = 'blocked'
      else if (findings.some(item => ['needs_confirmation', 'needs_info'].includes(item.status) && item.severity === 'blocker' && item.display !== false)) target.status = 'needs_confirmation'
      else if (findings.some(item => item.status === 'needs_supplement' && item.severity === 'blocker' && item.display !== false)) target.status = 'needs_supplement'
      else target.status = 'passed'
    }
  }
  return target
}

function decorateReport(report, { snapshot = {}, chain = {}, externalSources = [], mode = 'business' } = {}) {
  const result = report && typeof report === 'object' ? report : {}
  // Preserve an already assigned demo mode when a caller re-decorates with
  // defaults (for example after loading a report for a later summary pass).
  const effectiveMode = mode === 'business' && ['demo', 'demo_validation'].includes(result.mode)
    ? result.mode
    : mode
  const resolvedChain = chain && typeof chain === 'object' ? chain : { nodeUids: [], auditNodeUids: [] }
  const nodes = chainUtils.nodesOf(snapshot)
  const data = chainUtils.collectChainData(snapshot, resolvedChain)
  const findings = (Array.isArray(result.findings) ? result.findings : []).map(original => {
    const finding = { ...original }
    finding.findingKey = findingKeyFor(finding)
    const contextual = finding.ruleId === 'CK-32'
      ? { entries: [], related: [], attached: [] }
      : entriesForFinding(finding, snapshot, resolvedChain, data, nodes)
    const entries = contextual.entries.slice()
    const currentBySource = new Map(entries.map(item => [`${item.sourceId}|${item.kind}|${item.label}`, item.contentHash]))
    for (const source of externalSources || []) {
      if (!source || !source.sourceRef) continue
      const sourceId = sourceIdFor(source.sourceRef)
      const contentHash = digest(String(source.content || ''))
      for (const kind of ['attachment', 'file_attachment']) currentBySource.set(`${sourceId}|${kind}|*`, contentHash)
    }
    const preserveKinds = new Set(['node_text', 'node_note', 'node_field', 'attachment', 'file_attachment'])
    for (const old of Array.isArray(original.evidenceEntries) ? original.evidenceEntries : []) {
      if (!old || old.complete !== true || !old.id || !old.sourceId || !old.contentHash || !preserveKinds.has(old.kind)) continue
      const currentHash = currentBySource.get(`${old.sourceId}|${old.kind}|${old.label}`) ||
        currentBySource.get(`${old.sourceId}|${old.kind}|*`)
      if (currentHash && currentHash !== old.contentHash) continue
      addUnique(entries, old)
    }
    const oldDiagnostic = String(Object.prototype.hasOwnProperty.call(finding, 'diagnostic')
      ? finding.diagnostic || '' : finding.evidence || '').trim()
    finding.evidenceEntries = entries
    finding.diagnostic = oldDiagnostic
    // Keep the legacy field source-safe: only validated excerpts remain in it.
    finding.evidence = entries.map(item => item.quote).join('\n')
    if (!finding.quote && entries.length === 1) finding.quote = entries[0].quote
    const locationList = contextual.related.map(uid => ({ nodeUid: uid, title: chainUtils.nodeText(nodes[uid]) || uid }))
    const incompleteSources = contextual.attached.filter(source => !statusComplete(source)).map(source => ({
      sourceId: sourceIdFor(source.sourceRef || { type: source.source || 'source', nodeUid: source.nodeUid }),
      title: String(source.title || source.name || '已绑定材料'),
      status: String(source.status || (source.truncated ? 'truncated' : 'incomplete')),
      complete: false
    }))
    finding.coverage = {
      checkedNodes: locationList,
      checkedLocations: [
        ...contextual.related.flatMap(uid => [
          { kind: 'node_text', nodeUid: uid },
          { kind: 'node_note', nodeUid: uid }
        ]),
        ...(finding.field && finding.nodeUid
          ? [{ kind: 'node_field', nodeUid: String(finding.nodeUid), field: finding.field, label: FIELD_LABELS[finding.field] || finding.field }]
          : [])
      ],
      sources: contextual.attached.map(source => ({
        sourceId: sourceIdFor(source.sourceRef || { type: source.source || 'source', nodeUid: source.nodeUid }),
        title: String(source.title || source.name || '已绑定材料'), complete: statusComplete(source),
        status: String(source.status || (statusComplete(source) ? 'ready' : 'incomplete'))
      })),
      incompleteSourceIds: incompleteSources.map(item => item.sourceId),
      complete: incompleteSources.length === 0,
      state: incompleteSources.length ? 'unverified' : 'complete'
    }

    if (finding.status === 'needs_supplement' && incompleteSources.length) {
      finding.diagnostic = finding.diagnostic || finding.message
      finding.status = 'needs_info'
      const labels = incompleteSources.map(item => item.title).join('、')
      finding.message = `节点中未找到明确${FIELD_LABELS[finding.field] || '必需信息'}；已绑定材料${labels}未完整读取，尚未核验其中是否包含该信息。`
      finding.nextStep = '先完成相关材料读取，再确认是否需要补充字段。'
    }

    finding.requiredEvidenceIds = buildRequiredEvidence(finding, entries, data)
    finding.reviewable = allowReview(finding, entries, finding.requiredEvidenceIds, finding.coverage.complete)
    if (finding.reviewable) finding.validationType = 'manual_text_review'
    finding.blocking = finding.severity === 'blocker' && UNRESOLVED_STATUSES.has(finding.status)
    finding.category = findingCategory(finding, finding.coverage.complete === false && incompleteSources.length > 0)
    if (effectiveMode === 'demo' || effectiveMode === 'demo_validation') {
      finding.provenanceMode = 'demo'
      finding.formalPassEligible = false
    } else finding.formalPassEligible = true
    return finding
  })
  result.findings = findings
  mergeSourceErrors(result, findings)
  // Recompute categories after duplicate source rows are marked auxiliary.
  for (const item of findings) item.category = findingCategory(item, item.coverage && item.coverage.complete === false && (item.coverage.incompleteSourceIds || []).length > 0)
  result.provenanceMode = effectiveMode === 'demo' || effectiveMode === 'demo_validation' ? 'demo' : 'business'
  result.formalPassEligible = result.provenanceMode === 'business'
  summarizeReport(result)
  return result
}

module.exports = { CATEGORIES, decorateReport, summarizeReport, evidenceEntry, visibleText, statusComplete }
