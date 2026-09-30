'use strict'

const crypto = require('crypto')

const CHECK_ALIASES = new Set(['c', 'check', '检查', '目标'])
const PLAN_ALIASES = new Set(['p', 'plan', '计划'])
const EXEC_ALIASES = new Set(['d', 'do', '执行', '动作'])

function stripMarkup(value) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function nodeText(node) {
  if (!node) return ''
  const data = node.data && typeof node.data === 'object' ? node.data : {}
  return stripMarkup(
    node.text != null
      ? node.text
      : data.text != null
        ? data.text
        : node.title != null
          ? node.title
          : ''
  )
}

function nodeNote(node) {
  const data = node && node.data && typeof node.data === 'object' ? node.data : {}
  return preserveNoteLines(node && node.note != null ? node.note : data.note || '')
}

function preserveNoteLines(value) {
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
}

function nodesOf(snapshot) {
  if (!snapshot) return {}
  const nodes = snapshot.nodes || snapshot.object || snapshot
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return {}
  return nodes
}

function buildParents(nodes) {
  const parents = new Map()
  Object.entries(nodes).forEach(([uid, node]) => {
    const explicit = node && (node.parent_uid || node.parentUid || node.parent)
    if (explicit && typeof explicit === 'string' && nodes[explicit]) {
      parents.set(uid, explicit)
    }
    ;((node && node.children) || []).forEach(child => {
      const childUid = typeof child === 'string' ? child : child && child.uid
      if (childUid && nodes[childUid] && !parents.has(childUid)) {
        parents.set(childUid, uid)
      }
    })
  })
  return parents
}

function pathFor(nodes, parents, uid) {
  const parts = []
  const seen = new Set()
  let cur = uid
  while (cur && nodes[cur] && !seen.has(cur)) {
    seen.add(cur)
    parts.unshift({ uid: cur, text: nodeText(nodes[cur]) })
    cur = parents.get(cur)
  }
  return parts
}

function walkSubtree(nodes, uid, out = [], seen = new Set()) {
  if (!uid || !nodes[uid] || seen.has(uid)) return out
  seen.add(uid)
  out.push(uid)
  ;((nodes[uid] && nodes[uid].children) || []).forEach(child => {
    walkSubtree(nodes, typeof child === 'string' ? child : child && child.uid, out, seen)
  })
  return out
}

function roleOf(value) {
  const text = stripMarkup(value).trim()
  const prefixed = text.match(/^([CPD])\s*[:：]/i)
  if (prefixed) return prefixed[1].toUpperCase()
  const bare = text.replace(/[：:]$/, '').trim().toLowerCase()
  if (CHECK_ALIASES.has(bare)) return 'C'
  if (PLAN_ALIASES.has(bare)) return 'P'
  if (EXEC_ALIASES.has(bare)) return 'D'
  return null
}

function isBareRoleLabel(value) {
  const text = stripMarkup(value).replace(/[：:]$/, '').trim().toLowerCase()
  return CHECK_ALIASES.has(text) || PLAN_ALIASES.has(text) || EXEC_ALIASES.has(text)
}

function isStepLabel(value) {
  return isExecutionStep(value)
}

function directChildUid(nodes, child) {
  const uid = typeof child === 'string' ? child : child && child.uid
  return uid && nodes[uid] ? uid : null
}

function makeCandidate(nodes, parents, ownerUid, checkRootUids, planRootUids, executionUids, selectedUid) {
  const ancestorPath = pathFor(nodes, parents, ownerUid)
  const nodeUids = new Set(ancestorPath.map(item => item.uid))
  if (selectedUid) pathFor(nodes, parents, selectedUid).forEach(item => nodeUids.add(item.uid))
  const auditNodeUids = new Set()
  for (const [role, roots] of [['C', checkRootUids], ['P', planRootUids], ['D', executionUids]]) {
    roots.forEach(uid => branchUids(nodes, uid, role).forEach(desc => { auditNodeUids.add(desc); nodeUids.add(desc) }))
  }
  const path = ancestorPath
  const title = nodeText(nodes[ownerUid]) || path[path.length - 1]?.text || ownerUid
  const pairKey = [...checkRootUids].sort().join(',') + '|' + [...planRootUids].sort().join(',') + '|' + [...executionUids].sort().join(',')
  const suffix = crypto.createHash('sha1').update(pairKey).digest('hex').slice(0, 10)
  return {
    candidateId: `chain:${ownerUid}:${suffix}`,
    chainUid: ownerUid,
    ownerUid,
    title,
    path,
    pathText: path.map(item => item.text).filter(Boolean).join(' / '),
    checkRootUids: [...checkRootUids],
    planRootUids: [...planRootUids],
    executionUids: [...executionUids],
    nodeUids: [...nodeUids],
    auditNodeUids: [...auditNodeUids],
    contextNodeUids: [...nodeUids].filter(uid => !auditNodeUids.has(uid)),
    selectedUid: selectedUid || null
  }
}

function isExecutionStep(text) {
  return /^(?:执行者|AI|人|人工|执行)\s*[:：]/i.test(stripMarkup(text))
}

// Descend through plain grouping nodes, stopping at a different CPD branch.
function branchUids(nodes, rootUid, mode) {
  const out = []
  const seen = new Set()
  const rootBare = isBareRoleLabel(nodeText(nodes[rootUid]))
  const visit = uid => {
    if (!nodes[uid] || seen.has(uid)) return
    seen.add(uid)
    const role = roleOf(nodeText(nodes[uid]))
    if (uid !== rootUid) {
      if (mode === 'D' && (role === 'C' || role === 'P')) return
      if (mode !== 'D' && (role && (role !== mode || !rootBare) || isStepLabel(nodeText(nodes[uid])))) return
    }
    out.push(uid)
    for (const child of nodes[uid].children || []) visit(directChildUid(nodes, child))
  }
  visit(rootUid)
  return out
}

function firstRoleRoots(nodes, rootUid, wanted) {
  const found = []
  const seen = new Set()
  const visit = uid => {
    if (!uid || !nodes[uid] || seen.has(uid)) return
    seen.add(uid)
    const role = roleOf(nodeText(nodes[uid]))
    if (uid !== rootUid && role) {
      if (role === wanted || wanted === 'D' && isExecutionStep(nodeText(nodes[uid]))) found.push(uid)
      return
    }
    if (uid !== rootUid && wanted === 'D' && isExecutionStep(nodeText(nodes[uid]))) {
      found.push(uid)
      return
    }
    for (const child of nodes[uid].children || []) visit(directChildUid(nodes, child))
  }
  visit(rootUid)
  return found
}

function relatedChecks(nodes, parents, planUid) {
  let cur = planUid
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const parent = parents.get(cur)
    if (!parent) break
    const parentRole = roleOf(nodeText(nodes[parent]))
    const siblings = (nodes[parent].children || []).map(child => directChildUid(nodes, child))
      .filter(uid => uid && roleOf(nodeText(nodes[uid])) === 'C')
    if (parentRole === 'C') return isBareRoleLabel(nodeText(nodes[parent])) ? [parent] : [parent, ...siblings]
    if (siblings.length) return siblings
    if (parentRole === 'D') return []
    cur = parent
  }
  return []
}

function discoverCandidates(snapshot, targetUid) {
  const nodes = nodesOf(snapshot)
  if (!targetUid || !nodes[targetUid]) return []
  const parents = buildParents(nodes)
  const path = pathFor(nodes, parents, targetUid).map(item => item.uid).reverse()
  let nearestD = path.find(uid => roleOf(nodeText(nodes[uid])) === 'D') ||
    path.find(uid => isExecutionStep(nodeText(nodes[uid])))
  if (nearestD && nearestD !== targetUid && isBareRoleLabel(nodeText(nodes[nearestD]))) nearestD = targetUid
  let nearestP = path.find(uid => roleOf(nodeText(nodes[uid])) === 'P')
  // A P item inside a bare P container is a target clause of that container.
  if (nearestP && isBareRoleLabel(nodeText(nodes[parents.get(nearestP)])) &&
      roleOf(nodeText(nodes[parents.get(nearestP)])) === 'P') nearestP = parents.get(nearestP)
  if (nearestD && nearestP && path.indexOf(nearestD) > path.indexOf(nearestP)) nearestD = null
  const candidates = []
  const addPlan = planUid => {
    const checks = relatedChecks(nodes, parents, planUid)
    let execution = nearestD ? [nearestD] : firstRoleRoots(nodes, planUid, 'D')
    if (!nearestD && !execution.length && targetUid !== planUid && !roleOf(nodeText(nodes[targetUid]))) execution = [targetUid]
    for (const checkUid of checks) {
      candidates.push(makeCandidate(nodes, parents, planUid, [checkUid], [planUid], execution, targetUid))
    }
  }
  if (nearestP) addPlan(nearestP)
  else if (nearestD) {
    // Same-level layout: present each possible P rather than merging siblings.
    for (const owner of path.slice(path.indexOf(nearestD) + 1)) {
      const plans = (nodes[owner].children || []).map(child => directChildUid(nodes, child))
        .filter(uid => uid && roleOf(nodeText(nodes[uid])) === 'P')
      if (plans.length) { plans.forEach(addPlan); break }
    }
  } else {
    // A selected C/owner can contain multiple independent P branches. Only
    // discover beneath that selection; never expand another ancestor's tree.
    const role = roleOf(nodeText(nodes[targetUid]))
    const nearestC = path.find(uid => roleOf(nodeText(nodes[uid])) === 'C')
    if (role === 'C' || nearestC) {
      const checkUid = nearestC || targetUid
      const plans = firstRoleRoots(nodes, checkUid, 'P')
      plans.forEach(addPlan)
      if (!plans.length) firstRoleRoots(nodes, checkUid, 'C')
        .forEach(childC => firstRoleRoots(nodes, childC, 'P').forEach(addPlan))
      const owner = parents.get(checkUid)
      if (owner) (nodes[owner].children || []).map(child => directChildUid(nodes, child))
        .filter(uid => uid && roleOf(nodeText(nodes[uid])) === 'P').forEach(addPlan)
    }
    else {
      const directPlans = firstRoleRoots(nodes, targetUid, 'P')
      directPlans.forEach(addPlan)
      firstRoleRoots(nodes, targetUid, 'C').forEach(checkUid => firstRoleRoots(nodes, checkUid, 'P').forEach(addPlan))
    }
  }
  return [...new Map(candidates.map(candidate => [candidate.candidateId, candidate])).values()]
}
function distanceToAncestor(nodes, parents, nodeUid, ancestorUid) {
  let current = nodeUid
  let distance = 0
  const seen = new Set()
  while (current && nodes[current] && !seen.has(current)) {
    if (current === ancestorUid) return distance
    seen.add(current)
    current = parents.get(current)
    distance += 1
  }
  return null
}

function resolveCheckChain(snapshot, nodeUid, selectedCandidateId) {
  const nodes = nodesOf(snapshot)
  const uid = String(nodeUid || '')
  if (!uid || !nodes[uid]) {
    return { status: 'not_found', chainUid: null, candidates: [], chain: null }
  }
  const parents = buildParents(nodes)
  const all = discoverCandidates(snapshot, uid)
  const enclosing = all
    .map(candidate => ({
      candidate,
      distance: distanceToAncestor(nodes, parents, uid, candidate.ownerUid) ??
        (candidate.auditNodeUids.includes(uid) ? 0 : null)
    }))
    .filter(item => item.distance != null)
    .sort((a, b) => a.distance - b.distance || a.candidate.pathText.localeCompare(b.candidate.pathText))

  if (selectedCandidateId) {
    const matching = all.filter(candidate => candidate.candidateId === selectedCandidateId || candidate.chainUid === selectedCandidateId)
    const selected = matching.length === 1 ? matching[0] : null
    const selectedInside = selected && (selected.auditNodeUids.includes(uid) || distanceToAncestor(nodes, parents, uid, selected.ownerUid) != null)
    const selectedAbove = selected && distanceToAncestor(nodes, parents, selected.ownerUid, uid) != null
    if (!selected || (!selectedInside && !selectedAbove)) {
      return { status: 'not_found', chainUid: null, candidates: [], chain: null }
    }
    const resolved = { ...selected, selectedUid: uid }
    if (!resolved.executionUids.length) resolved.executionUids = [uid]
    if (!resolved.executionUids.some(execUid => roleOf(nodeText(nodes[execUid])) === 'D')) {
      resolved.logicalDUid = uid
      if (!resolved.nodeUids.includes(uid)) resolved.nodeUids.push(uid)
    }
    return { status: 'resolved', chainUid: resolved.chainUid, candidates: [resolved], chain: resolved }
  }

  let nearest = []
  if (enclosing.length) {
    const nearestDistance = enclosing[0].distance
    nearest = enclosing.filter(item => item.distance === nearestDistance).map(item => item.candidate)
  } else {
    const descendants = all.filter(candidate => distanceToAncestor(nodes, parents, candidate.ownerUid, uid) != null)
    if (descendants.length === 1) nearest = descendants
    else if (descendants.length > 1) {
      return { status: 'needs_confirmation', chainUid: null, candidates: descendants, chain: null }
    }
  }
  if (!nearest.length) return { status: 'not_found', chainUid: null, candidates: [], chain: null }
  if (nearest.length > 1) {
    return { status: 'needs_confirmation', chainUid: null, candidates: nearest, chain: null }
  }
  const resolved = { ...nearest[0], selectedUid: uid }
  if (!resolved.executionUids.length) resolved.executionUids = [uid]
  if (!resolved.executionUids.some(execUid => roleOf(nodeText(nodes[execUid])) === 'D')) {
    resolved.logicalDUid = uid
    if (!resolved.nodeUids.includes(uid)) resolved.nodeUids.push(uid)
  }
  return { status: 'resolved', chainUid: resolved.chainUid, candidates: [resolved], chain: resolved }
}

function candidateForUid(snapshot, nodeUid, candidateId) {
  const resolved = resolveCheckChain(snapshot, nodeUid, candidateId)
  return resolved.status === 'resolved' ? resolved.chain : null
}

function fingerprintChain(snapshot, chain) {
  const nodes = nodesOf(snapshot)
  const nodeUids = new Set((chain && chain.nodeUids) || [])
  const payload = [...nodeUids].sort().map(uid => {
    const node = nodes[uid] || {}
    const data = node.data && typeof node.data === 'object' ? node.data : {}
    return {
      uid,
      fields: Object.fromEntries([
        'frequency','inputs','input','dataSource','criterion','criteria','owner','outputs','output',
        'targetValue','target_value','objective','remediation','failureHandling','sopCard','card',
        'sop_id','title','cpd_path','role','steps','project','version','status','confidential','visibility'
      ].filter(key => data[key] !== undefined).map(key => [key, data[key]])),
      text: nodeText(node),
      note: nodeNote(node),
      children: (node.children || []).map(child => typeof child === 'string' ? child : child && child.uid)
        .filter(childUid => (chain.auditNodeUids || []).includes(uid) || nodeUids.has(childUid)),
      attachments: data.attachments || node.attachments || [],
      attachmentId: data.attachmentId || node.attachmentId || '',
      cpdCheckReferences: data.cpdCheckReferences || [],
      links: data.links || node.links || [],
      hyperlink: data.hyperlink || node.hyperlink || '',
      url: data.url || node.url || ''
    }
  })
  const sources = ((snapshot && snapshot.sources) || [])
    .filter(source => !source.nodeUid || nodeUids.has(source.nodeUid))
    .map(source => ({
      sourceRef: source.sourceRef || null,
      version: source.version == null ? null : String(source.version),
      complete: source.complete !== false,
      truncated: !!source.truncated,
      contentHash: crypto.createHash('sha256').update(String(source.content || '')).digest('hex')
    }))
    .sort((a, b) => JSON.stringify(a.sourceRef).localeCompare(JSON.stringify(b.sourceRef)))
  return crypto.createHash('sha256').update(JSON.stringify({ payload, sources })).digest('hex')
}

function collectChainData(snapshot, chain) {
  const nodes = nodesOf(snapshot)
  const parents = buildParents(nodes)
  const cpRoots = [...(chain.checkRootUids || []), ...(chain.planRootUids || [])]
  const checkNodes = []
  const planNodes = []
  const auditScope = new Set(chain.auditNodeUids || chain.nodeUids || [])
  const collectBranch = (root, target, boundaryRoles, includeRoot = false) => {
    const visited = new Set()
    const visit = uid => {
      if (!uid || !nodes[uid] || visited.has(uid) || !auditScope.has(uid)) return
      visited.add(uid)
      const text = nodeText(nodes[uid])
      const role = roleOf(text)
      const isRoot = uid === root
      if (!isRoot && (boundaryRoles.has(role) || isStepLabel(text))) return
      if ((includeRoot || !isRoot) && !isBareRoleLabel(text)) {
        const childUids = ((nodes[uid] && nodes[uid].children) || [])
          .map(child => typeof child === 'string' ? child : child && child.uid).filter(Boolean)
        target.push({
          uid,
          text,
          note: nodeNote(nodes[uid]),
          role,
          parentUid: parents.get(uid) || null,
          children: childUids,
          leaf: childUids.length === 0
        })
      }
      ;((nodes[uid] && nodes[uid].children) || []).forEach(child => visit(typeof child === 'string' ? child : child && child.uid))
    }
    visit(root)
  }
  const cSeen = new Set()
  ;(chain.checkRootUids || []).forEach(root => {
    const tmp = []
    collectBranch(root, tmp, new Set(['P', 'D']), true)
    tmp.forEach(item => { if (!cSeen.has(item.uid)) { cSeen.add(item.uid); checkNodes.push(item) } })
  })
  const pSeen = new Set()
  ;(chain.planRootUids || []).forEach(root => {
    const tmp = []
    collectBranch(root, tmp, new Set(['C', 'D']), true)
    tmp.forEach(item => { if (!pSeen.has(item.uid)) { pSeen.add(item.uid); planNodes.push(item) } })
  })
  const dNodes = []
  const steps = []
  const dSeen = new Set()
  const dRoots = chain.executionUids || []
  dRoots.forEach(root => walkSubtree(nodes, root).forEach(uid => {
    if (dSeen.has(uid) || !auditScope.has(uid)) return
    const item = { uid, text: nodeText(nodes[uid]), note: nodeNote(nodes[uid]), role: roleOf(nodeText(nodes[uid])), parentUid: parents.get(uid) || null }
    if (item.role === 'D' && !isBareRoleLabel(item.text)) {
      dSeen.add(uid)
      dNodes.push(item)
    } else if (isStepLabel(item.text)) {
      dSeen.add(uid)
      steps.push(item)
    }
  }))
  // D-prefixed items can be descendants of a P branch; preserve them as D roots.
  planNodes.forEach(item => {
    if (item.role === 'D' && !isBareRoleLabel(item.text) && !dSeen.has(item.uid)) {
      dSeen.add(item.uid)
      dNodes.push(item)
    }
  })
  // A role-prefixed execution step can represent an executable D when no
  // separate D node exists. The selected task is the final safe fallback.
  if (!dNodes.length) {
    ;[...planNodes, ...dRoots.map(uid => ({ uid, text: nodeText(nodes[uid]) }))].forEach(item => {
      if (!isExecutionStep(item.text) || dSeen.has(item.uid)) return
      dSeen.add(item.uid)
      steps.push({ uid: item.uid, text: nodeText(nodes[item.uid]), note: nodeNote(nodes[item.uid]), role: 'D', parentUid: parents.get(item.uid) || null })
    })
  }
  if (!dNodes.length && chain.logicalDUid && nodes[chain.logicalDUid]) {
    const uid = chain.logicalDUid
    dNodes.push({ uid, text: nodeText(nodes[uid]), note: nodeNote(nodes[uid]), role: roleOf(nodeText(nodes[uid])), parentUid: parents.get(uid) || null, logical: true, children: nodes[uid].children || [], leaf: !(nodes[uid].children || []).length })
  }
  return { checkNodes, planNodes, dNodes, steps, nodes, parents, cpRoots }
}

module.exports = {
  nodesOf,
  nodeText,
  nodeNote,
  preserveNoteLines,
  roleOf,
  isBareRoleLabel,
  isExecutionStep,
  buildParents,
  pathFor,
  walkSubtree,
  discoverCandidates,
  resolveCheckChain,
  candidateForUid,
  fingerprintChain,
  collectChainData
}
