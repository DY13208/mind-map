/**
 * 无超链接 SOP：校验本图流程是否流畅，以及能否衔接到同属最近 P 下的关联节点。
 */

const P_TITLE_RE = /^P(?!\d)\s*[：:]/i
const D_TITLE_RE = /^D(?!\d)\s*[：:]/i
const GAP_RE = /待定|TBD|TODO|？{2,}|\?{2,}|暂无|未填写|待补充|xxx+/i

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function nodeText(node) {
  return stripHtml((node && (node.text || node.title)) || '')
}

function nodeHasOwnHyperlink(node) {
  return !!(node && String(node.hyperlink || '').trim())
}

function buildByUid(flatNodes) {
  const byUid = new Map()
  ;(flatNodes || []).forEach(n => {
    if (n && n.uid) byUid.set(n.uid, n)
  })
  return byUid
}

function childUids(node) {
  if (!node) return []
  if (Array.isArray(node.children) && node.children.length) {
    return node.children.map(c => (typeof c === 'string' ? c : c && c.uid)).filter(Boolean)
  }
  return []
}

/** 收集 rootUid 子树内全部节点（含自身） */
export function collectSubtreeNodes(flatNodes, rootUid) {
  const byUid = buildByUid(flatNodes)
  const root = String(rootUid || '').trim()
  if (!root || !byUid.has(root)) return []
  const out = []
  const seen = new Set()
  const walk = uid => {
    if (!uid || seen.has(uid) || !byUid.has(uid)) return
    seen.add(uid)
    const node = byUid.get(uid)
    out.push(node)
    childUids(node).forEach(walk)
  }
  walk(root)
  return out
}

/** 当前 D 自身或子树是否含超链接 */
export function subtreeHasHyperlink(flatNodes, rootUid) {
  return collectSubtreeNodes(flatNodes, rootUid).some(nodeHasOwnHyperlink)
}

/** 沿祖先找最近 P（标题匹配 P：…） */
export function findNearestP(flatNodes, sopUid) {
  const byUid = buildByUid(flatNodes)
  const start = byUid.get(String(sopUid || '').trim())
  if (!start) return null
  let parent = start.parent_uid || start.parentUid || ''
  const seen = new Set()
  while (parent && byUid.has(parent) && !seen.has(parent)) {
    seen.add(parent)
    const node = byUid.get(parent)
    const text = nodeText(node)
    if (P_TITLE_RE.test(text) || /^P$/i.test(text)) {
      return {
        uid: node.uid,
        title: text,
        node
      }
    }
    parent = node.parent_uid || node.parentUid || ''
  }
  return null
}

/**
 * 同 P 子树内除 self 外的关联节点（优先 D，其次带超链接/关键步骤标题的节点）
 */
export function listRelatedUnderP(flatNodes, pUid, selfUid) {
  const byUid = buildByUid(flatNodes)
  const p = String(pUid || '').trim()
  const self = String(selfUid || '').trim()
  if (!p || !byUid.has(p)) return []

  const selfSubtree = new Set(
    collectSubtreeNodes(flatNodes, self).map(n => n.uid)
  )

  const underP = collectSubtreeNodes(flatNodes, p).filter(
    n => n && n.uid && n.uid !== p && !selfSubtree.has(n.uid)
  )

  const peers = []
  underP.forEach(node => {
    const title = nodeText(node)
    if (!title) return
    const isD = D_TITLE_RE.test(title)
    const isStepish =
      /^(AI|人|HRBP|需求方|系统)\s*[：:]/i.test(title) ||
      /^\d+[、.．)]/.test(title)
    const hasLink = nodeHasOwnHyperlink(node)
    // 只收：其它 D、或关键步骤/带超链接的跳点
    if (!isD && !hasLink && !isStepish) return
    // 若在某个兄弟 D 子树里且不是 D 本身，跳过（避免把兄弟 D 内部步骤全列出来）
    if (!isD) {
      let parent = node.parent_uid || node.parentUid || ''
      const seen = new Set()
      while (parent && byUid.has(parent) && parent !== p && !seen.has(parent)) {
        seen.add(parent)
        const pt = nodeText(byUid.get(parent))
        if (D_TITLE_RE.test(pt)) return
        parent = byUid.get(parent).parent_uid || byUid.get(parent).parentUid || ''
      }
    }
    peers.push({
      uid: node.uid,
      title,
      isD,
      hasHyperlink: hasLink,
      hyperlink: String(node.hyperlink || '').trim()
    })
  })

  // D 优先，再按标题
  peers.sort((a, b) => {
    if (a.isD !== b.isD) return a.isD ? -1 : 1
    return String(a.title).localeCompare(String(b.title))
  })
  return peers
}

/** 本 SOP 流畅启发式 */
export function assessSopFlow(sop, flatNodes = []) {
  const issues = []
  const uid = (sop && sop.uid) || ''
  const subtree = collectSubtreeNodes(flatNodes, uid)
  const descendants = subtree.filter(n => n.uid !== uid)
  const titles = descendants.map(nodeText).filter(Boolean)

  if (!descendants.length) {
    issues.push('本 SOP 下没有可执行子步骤，流程可能无法推进')
  } else if (descendants.length === 1 && !childUids(descendants[0]).length) {
    issues.push('仅有一层空壳步骤，缺少可执行细节')
  }

  const gapTitles = titles.filter(t => GAP_RE.test(t)).slice(0, 5)
  if (gapTitles.length) {
    issues.push(`存在断档占位文案：${gapTitles.join('、')}`)
  }

  const cpda = (sop && sop.cpda) || {}
  const pSteps = Array.isArray(cpda.P) ? cpda.P.filter(Boolean) : []
  const cSteps = Array.isArray(cpda.C) ? cpda.C.filter(Boolean) : []
  if (pSteps.length && pSteps.length < 2) {
    issues.push('计划步骤（P）过少，流畅度不足')
  }
  if (cSteps.length === 0 && descendants.length >= 3) {
    // 信息性：有步骤但无验收项
    issues.push('未识别到验收项（C），完成后难以对照验收')
  }

  return {
    ok: issues.length === 0,
    issues
  }
}

/** 同 P 衔接 */
export function assessPContinuity(sop, peers = []) {
  const issues = []
  const list = peers || []
  const hasP = !!(sop && sop.nearestPUid)
  if (!hasP) {
    issues.push('无所属 P 祖先，无法做同 P 衔接校验')
  }

  const otherDs = list.filter(p => p.isD)
  if (otherDs.length) {
    const unlinkedDs = otherDs.filter(p => !p.hasHyperlink)
    if (unlinkedDs.length === otherDs.length) {
      issues.push(
        `同 P 下另有 ${otherDs.length} 个 D，彼此均无超链接，跨节点跳转缺失，需人工确认衔接`
      )
    } else if (unlinkedDs.length) {
      issues.push(
        `同 P 下部分关联 D 无超链接：${unlinkedDs
          .slice(0, 4)
          .map(p => p.title)
          .join('、')}`
      )
    }
  } else if (list.length === 0 && hasP) {
    issues.push('同 P 下未发现其它可衔接关联节点（仅本 SOP）')
  }

  return {
    ok: issues.length === 0,
    issues,
    peers: list
  }
}

/**
 * 无超链接时的综合评估。有超链接则 needsCheck=false。
 */
export function assessNoHyperlinkContinuity(sop, flatNodes = []) {
  const uid = (sop && sop.uid) || ''
  const hasLink =
    !!(sop && sop.hasHyperlink) || subtreeHasHyperlink(flatNodes, uid)

  if (hasLink) {
    return {
      needsCheck: false,
      hasHyperlink: true,
      level: 'info',
      flowIssues: [],
      peerIssues: [],
      peers: [],
      nearestP: null,
      summary: ''
    }
  }

  const nearestP =
    (sop && sop.nearestPUid
      ? { uid: sop.nearestPUid, title: sop.nearestPTitle || '' }
      : null) || findNearestP(flatNodes, uid)

  const peers =
    (sop && Array.isArray(sop.peerNodesUnderP) && sop.peerNodesUnderP.length
      ? sop.peerNodesUnderP
      : null) ||
    (nearestP ? listRelatedUnderP(flatNodes, nearestP.uid, uid) : [])

  const flow = assessSopFlow(
    {
      ...sop,
      nearestPUid: nearestP && nearestP.uid
    },
    flatNodes
  )
  const peer = assessPContinuity(
    {
      ...sop,
      nearestPUid: nearestP && nearestP.uid
    },
    peers
  )

  const flowIssues = flow.issues || []
  const peerIssues = peer.issues || []
  const all = [...flowIssues, ...peerIssues]
  let level = 'info'
  if (all.length) level = 'warn'
  if (
    flowIssues.some(i => /没有可执行子步骤|空壳步骤/.test(i)) &&
    peerIssues.some(i => /无所属 P|跨节点跳转缺失/.test(i))
  ) {
    level = 'block'
  }

  const lines = []
  lines.push('本 SOP 子树未发现超链接，将校验流程流畅与同 P 衔接。')
  if (nearestP) {
    lines.push(`所属 P：${nearestP.title || nearestP.uid}`)
  }
  if (flowIssues.length) {
    lines.push('【流畅】')
    flowIssues.forEach(i => lines.push(`· ${i}`))
  } else {
    lines.push('【流畅】未发现明显断档')
  }
  if (peerIssues.length) {
    lines.push('【同 P 衔接】')
    peerIssues.forEach(i => lines.push(`· ${i}`))
  }
  if (peers.length) {
    lines.push('【关联节点】')
    peers.slice(0, 12).forEach(p => {
      lines.push(
        `· ${p.title}${p.isD ? '（D）' : ''}${p.hasHyperlink ? ' · 有链接' : ' · 无链接'}`
      )
    })
  }

  return {
    needsCheck: true,
    hasHyperlink: false,
    level,
    flowIssues,
    peerIssues,
    peers,
    nearestP,
    summary: lines.join('\n')
  }
}

/** 写入运行 extraNote 的关联节点摘要 */
export function formatContinuityExtraNote(assessment) {
  if (!assessment || !assessment.needsCheck) return ''
  const lines = ['## 同P关联节点（无超链接校验）']
  if (assessment.nearestP) {
    lines.push(`所属P：${assessment.nearestP.title || assessment.nearestP.uid}`)
  }
  if (assessment.flowIssues && assessment.flowIssues.length) {
    lines.push('流畅提示：')
    assessment.flowIssues.forEach(i => lines.push(`- ${i}`))
  }
  const peers = assessment.peers || []
  if (peers.length) {
    lines.push('关联节点：')
    peers.forEach(p => {
      lines.push(
        `- ${p.title}${p.isD ? ' [D]' : ''}${
          p.hasHyperlink ? ` → ${p.hyperlink}` : '（无超链接）'
        }`
      )
    })
  } else {
    lines.push('关联节点：（无）')
  }
  lines.push(
    '说明：本 SOP 无超链接，请按同 P 下关联关系衔接执行；不要向用户索要超链接补数。'
  )
  return lines.join('\n')
}

/** 给 Registry SOP 列表补 hasHyperlink / nearestP / peers */
export function enrichSopsWithContinuityMeta(sops, flatNodes = []) {
  return (sops || []).map(sop => {
    if (!sop || !sop.uid) return sop
    const hasHyperlink = subtreeHasHyperlink(flatNodes, sop.uid)
    const nearestP = findNearestP(flatNodes, sop.uid)
    const peers = nearestP
      ? listRelatedUnderP(flatNodes, nearestP.uid, sop.uid)
      : []
    return {
      ...sop,
      hasHyperlink,
      nearestPUid: (nearestP && nearestP.uid) || '',
      nearestPTitle: (nearestP && nearestP.title) || '',
      peerNodesUnderP: peers
    }
  })
}
