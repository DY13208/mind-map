'use strict'

const crypto = require('crypto')
const chainUtils = require('./chain')
const { RULE_VERSION } = require('./rules')

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}
function sourceKey(ref) { return stableJson(ref || null) }

/** Read-only validation shared by report reads and candidate confirmation. */
async function checkRunFreshness(run, deps = {}, options = {}) {
  const stale = (reason, snapshot = null, chain = null) => ({ fresh: false, reason, snapshot, chain, sourceRefs: [] })
  if (!run || !run.report || run.ruleVersion !== RULE_VERSION || run.report.ruleVersion !== RULE_VERSION) {
    return stale('检查规则版本已变化，请重新检查。')
  }
  if (typeof deps.loadSnapshot !== 'function' && !options.snapshot) return stale('无法读取当前链路，请重新检查。')
  let snapshot
  try { snapshot = options.snapshot || await deps.loadSnapshot(run.roomKey, run.nodeUid) }
  catch (_) { return stale('当前链路不可读取，请重新检查。') }
  const nodes = chainUtils.nodesOf(snapshot)
  if (!nodes[run.nodeUid]) return stale('检查节点已不存在，请重新检查。', snapshot)
  const choice = run.selection && run.selection.chainCandidateId || run.report.chain && run.report.chain.chainUid
  const resolved = chainUtils.resolveCheckChain(snapshot, run.nodeUid, choice)
  let fingerprint
  let chain = resolved.chain || null
  if (resolved.status === 'resolved') fingerprint = chainUtils.fingerprintChain(snapshot, chain)
  else if (resolved.status === 'needs_confirmation') {
    fingerprint = hash((resolved.candidates || []).map(candidate => chainUtils.fingerprintChain(snapshot, candidate)).sort().join('|'))
  } else {
    fingerprint = hash(stableJson({ nodeUid: run.nodeUid,
      path: chainUtils.pathFor(nodes, chainUtils.buildParents(nodes), run.nodeUid) }))
  }
  const nodeOnlyFresh = options.skipSources && chain && run.report.nodeFingerprint &&
    chainUtils.fingerprintChain({ ...snapshot, sources: [] }, chain) === run.report.nodeFingerprint
  if (!run.chainFingerprint || (!nodeOnlyFresh && fingerprint !== run.chainFingerprint)) {
    return stale('链路节点、对应关系或附件已变化，请重新检查。', snapshot, chain)
  }
  if (options.candidateId) {
    const selected = chainUtils.resolveCheckChain(snapshot, run.nodeUid, options.candidateId)
    if (selected.status !== 'resolved') return stale('候选对应关系已变化，请重新检查。', snapshot)
    chain = selected.chain
  }
  const scoped = new Set(chain && chain.nodeUids || [])
  const localSources = (Array.isArray(snapshot.sources) ? snapshot.sources : []).filter(source => {
    const uid = source.nodeUid || source.sourceRef && source.sourceRef.nodeUid
    return !uid || !chain || scoped.has(uid)
  })
  const readSource = deps.readSource || deps.providers && deps.providers.readSource
  if (options.skipSources) return { fresh: true, snapshot, chain, reason: '', sourceRefs: run.sourceRefs || [] }
  const sourceRefs = []
  const checked = new Map()
  for (const source of run.sourceRefs || []) {
    const ref = source.sourceRef
    if (!ref) return stale('检查来源缺少可核验的标识，请重新检查。', snapshot, chain)
    const key = sourceKey(ref)
    let latest = localSources.find(item => sourceKey(item.sourceRef) === key)
    if (!latest) {
      if (checked.has(key)) latest = checked.get(key)
      else {
        if (typeof readSource !== 'function') return stale('无法核验外部来源，请重新检查。', snapshot, chain)
        try { latest = await readSource({ roomKey: run.roomKey, sourceRef: ref, actor: options.actor, mode: run.report.mode || 'business', requestCache: deps.requestCache }) }
        catch (_) { return stale('外部来源不可读取，请重新检查。', snapshot, chain) }
        checked.set(key, latest)
      }
      if (!latest || (source.complete !== false && latest.status !== 'ok')) return stale('外部来源不可用或无权读取，请重新检查。', snapshot, chain)
    }
    const complete = latest.complete !== false && !latest.truncated
    if (String(latest.version || '') !== String(source.version || '') ||
        hash(latest.content) !== String(source.contentHash || '') ||
        complete !== (source.complete !== false && !source.truncated) ||
        (source.status && String(latest.status || 'unknown') !== source.status)) {
      return stale('引用材料版本、正文或读取状态已变化，请重新检查。', snapshot, chain)
    }
    sourceRefs.push({ ...source, version: String(latest.version || ''), contentHash: hash(latest.content),
      complete, truncated: !!latest.truncated, status: latest.status || 'unknown' })
  }
  return { fresh: true, snapshot, chain, reason: '', sourceRefs }
}

module.exports = { checkRunFreshness, stableJson, sourceKey, hash }
