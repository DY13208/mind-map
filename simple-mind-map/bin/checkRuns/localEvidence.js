'use strict'

const crypto = require('crypto')
const chainUtils = require('./chain')
const rules = require('./rules')

const LABELS = {
  frequency: ['频率', '周期', '时间要求'], inputs: ['输入源', '输入', '数据源', '依赖资料'],
  criterion: ['判据', '检查标准', '验收标准', '完成标准', '达标条件'],
  owner: ['责任人', '负责人', '执行人'], outputs: ['产物', '输出', '交付物'],
  targetValue: ['目标值', '目标'], remediation: ['未达标处置', '异常处置', '不达标处置']
}
function hash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex') }
function meaningful(value) {
  return typeof value === 'string' && !!value.trim() && !/^(待补充|待确认|未知|未定|暂无|todo|tbd)$/i.test(value.trim())
}
function fieldQuote(text, field) {
  const lines = String(text || '').split(/\r?\n|；|;/)
  for (const line of lines) {
    const normalized = line.replace(/^\s*[-*•]\s*/, '').replace(/\*\*/g, '').trim()
    for (const label of LABELS[field] || []) {
      const match = normalized.match(new RegExp(`^${label}\\s*[:：=]\\s*(.+)$`))
      if (match && meaningful(match[1]) && (field !== 'targetValue' || rules.hasMetric(match[1]))) {
        return { value: match[1].trim(), quote: line.trim() }
      }
    }
  }
  return null
}

function completeSource(source) {
  const status = String(source && source.status || '').toLowerCase()
  return !!source && source.complete !== false && !source.truncated &&
    (!status || status === 'ready' || status === 'ok')
}

function linkedAttachments(snapshot, chain) {
  const nodes = chainUtils.nodesOf(snapshot)
  const allowed = new Set([...(chain.auditNodeUids || []), ...(chain.nodeUids || [])].map(String))
  return (Array.isArray(snapshot && snapshot.sources) ? snapshot.sources : []).filter(source => {
    if (!completeSource(source)) return false
    const ref = source.sourceRef || {}
    const type = String(ref.type || source.source || source.kind || '').toLowerCase()
    const nodeUid = String(source.nodeUid || ref.nodeUid || '')
    if (!nodeUid || !allowed.has(nodeUid) || !nodes[nodeUid]) return false
    const raw = nodes[nodeUid].data && typeof nodes[nodeUid].data === 'object' ? nodes[nodeUid].data : {}
    const attachmentIds = [].concat(raw.attachments || [], raw.attachmentId || [], raw.attachmentIds || [])
      .map(item => typeof item === 'object' ? item.id || item.attachmentId || item.uid : item)
      .filter(value => value != null).map(String)
    const id = String(ref.id || ref.attachmentId || source.attachmentId || '')
    if (type === 'attachment' || type === 'file_attachment') return !id || attachmentIds.includes(id)
    // Older snapshots can identify an attached material only by its owning
    // node. Accept that explicit node binding when no conflicting material id
    // is present; arbitrary graph or external sources remain excluded.
    return !type && !id && String(source.nodeUid || '') === nodeUid
  })
}

/** Find explicit local evidence before looking outside the inspected chain. */
function applyChainEvidence(snapshot, chain, findings, { roomKey = '' } = {}) {
  const nodes = chainUtils.nodesOf(snapshot)
  const parents = chainUtils.buildParents(nodes)
  const attachments = linkedAttachments(snapshot, chain)
  const localMaterialCandidates = []
  const enriched = (findings || []).map(finding => {
    if (!finding.field || !['needs_supplement', 'needs_info'].includes(finding.status)) return finding
    const matches = []
    if (finding.field === 'reference') {
      const term = String(finding.materialTerm || '') || String(finding.message || '').match(/[“「]([^”」]+)[”」]/)?.[1] || ''
      if (term) attachments.forEach(source => {
        const uid = source.nodeUid || source.sourceRef && source.sourceRef.nodeUid
        const content = String(source.content || '')
        const index = content.toLowerCase().indexOf(term.toLowerCase())
        if (index < 0) return
        matches.push({ uid, title: source.title || '本链路附件', sourceRef: source.sourceRef,
          version: source.version, value: '', quote: content.slice(Math.max(0, index - 40), index + term.length + 80) })
      })
    } else if (LABELS[finding.field]) {
      for (const uid of chain.nodeUids || []) {
        if (uid === finding.nodeUid) continue
        const node = nodes[uid]
        const data = node && node.data || {}
        if (!node || data.confidential === true || data.visibility === 'confidential') continue
        let match = fieldQuote(`${chainUtils.nodeText(node)}\n${chainUtils.nodeNote(node)}`, finding.field)
        const rawValue = data[finding.field]
        if (!match && meaningful(rawValue) && (finding.field !== 'targetValue' || rules.hasMetric(rawValue))) {
          const value = typeof rawValue === 'string' ? rawValue.trim() : JSON.stringify(rawValue)
          match = { value, quote: value, quoteKind: 'node_field' }
        }
        if (match) matches.push({ uid, title: chainUtils.nodeText(node) || uid, ...match,
          version: hash(`${chainUtils.nodeText(node)}\n${chainUtils.nodeNote(node)}\n${JSON.stringify(data)}`),
          sourceRef: { type: 'chain_node', roomKey, nodeUid: uid } })
      }

      // A complete, explicitly bound attachment is a local candidate. It can
      // stop unnecessary external search, but never changes a missing field
      // into a pass; the user still needs to add a verifiable field/reference.
      for (const source of attachments) {
        const match = fieldQuote(source.content, finding.field)
        if (!match) continue
        const ownerUid = String(source.nodeUid || source.sourceRef && source.sourceRef.nodeUid || '')
        matches.push({
          uid: ownerUid,
          title: source.title || source.name || '本链路已绑定材料',
          value: match.value,
          quote: match.quote,
          version: source.version || hash(source.content),
          sourceRef: source.sourceRef || { type: 'attachment', nodeUid: ownerUid },
          sourceKind: 'attachment'
        })
      }
    }
    if (!matches.length) return finding
    for (const match of matches) {
      localMaterialCandidates.push({
        candidateId: `local:${hash(`${finding.checkKey || finding.ruleId}:${finding.nodeUid}:${finding.field}:${match.uid}:${match.quote}`).slice(0, 24)}`,
        kind: 'material', source: 'chain', sourceRole: 'current_chain', title: match.title,
        path: match.uid ? chainUtils.pathFor(nodes, parents, match.uid).map(item => item.text).join(' / ') : '本链路材料',
        sourceRef: match.sourceRef, version: match.version, complete: true, independentEvidence: true,
        nodeUid: finding.nodeUid, sourceNodeUid: match.uid, field: finding.field,
        suggestedValue: match.value, quote: match.quote,
        quoteKind: match.quoteKind || match.sourceKind || 'node_text',
        matchReason: match.sourceKind === 'attachment'
          ? '本链路已绑定材料中找到字段候选；请确认其适用关系并补入当前字段或引用。'
          : '本链路已包含该项的明确原文；需要核对适用关系，不改变当前检查结论。'
      })
    }
    return { ...finding, localEvidenceFound: true, localCandidateIds: localMaterialCandidates.slice(-matches.length).map(item => item.candidateId),
      nextStep: '本链路已有候选依据，请核对该字段或材料的适用关系，再补齐并重新检查。' }
  })
  const unresolvedForSearch = enriched.filter(item => item.severity === 'blocker' && !item.localEvidenceFound &&
    ['needs_supplement', 'needs_info', 'needs_confirmation'].includes(item.status))
  return { findings: enriched, localMaterialCandidates, unresolvedForSearch }
}

module.exports = { applyChainEvidence, fieldQuote, linkedAttachments, completeSource }
