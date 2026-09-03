const STYLE_KEY = '__flowExpandStyleBackup'
const styledUids = new Set()

const RUNNING_STYLE = {
  borderColor: '#1268ff',
  borderWidth: 4
}

const QUEUED_STYLE = {
  borderColor: '#e6a23c',
  borderWidth: 3
}

function findNode(mindMap, uid) {
  if (!mindMap || !mindMap.renderer || !uid) return null
  return mindMap.renderer.findNodeByUid(uid)
}

function backupStyle(node) {
  if (!node || node[STYLE_KEY]) return
  node[STYLE_KEY] = {
    borderColor: node.getStyle('borderColor'),
    borderWidth: node.getStyle('borderWidth')
  }
}

function restoreStyle(mindMap, uid) {
  const node = findNode(mindMap, uid)
  if (!node || !node[STYLE_KEY]) {
    styledUids.delete(uid)
    return
  }
  mindMap.renderer.setNodeStyles(node, { ...node[STYLE_KEY] })
  delete node[STYLE_KEY]
  if (node.reRender) node.reRender()
  styledUids.delete(uid)
}

function applyStyle(mindMap, uid, style) {
  const node = findNode(mindMap, uid)
  if (!node) return false
  backupStyle(node)
  mindMap.renderer.setNodeStyles(node, style)
  if (node.reRender) node.reRender()
  styledUids.add(uid)
  return true
}

export function syncFlowExpandVisuals(mindMap, jobs) {
  if (!mindMap) return
  const active = new Map()
  ;(jobs || []).forEach(job => {
    if (!job || !job.nodeUid) return
    if (job.state === 'running' || job.state === 'queued') {
      active.set(job.nodeUid, job.state)
    }
  })

  Array.from(styledUids).forEach(uid => {
    if (!active.has(uid)) restoreStyle(mindMap, uid)
  })

  active.forEach((state, uid) => {
    applyStyle(
      mindMap,
      uid,
      state === 'running' ? RUNNING_STYLE : QUEUED_STYLE
    )
  })
}

export function clearAllFlowExpandVisuals(mindMap) {
  Array.from(styledUids).forEach(uid => restoreStyle(mindMap, uid))
  styledUids.clear()
}

export function focusFlowExpandNode(mindMap, uid) {
  if (!mindMap || !uid) return
  mindMap.execCommand('GO_TARGET_NODE', uid)
}
