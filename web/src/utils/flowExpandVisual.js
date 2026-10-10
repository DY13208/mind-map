// Fill state must never be persisted as node styling. Standard selection stays with renderer.
const legacyUids = new Set()
function restore(mindMap, uid) {
  const node = mindMap?.renderer?.findNodeByUid(uid),
    backup = node?.__flowExpandStyleBackup
  if (!backup) return
  const color = node.getStyle('borderColor'),
    width = node.getStyle('borderWidth')
  if (
    (color === '#1268ff' && width === 4) ||
    (color === '#e6a23c' && width === 3)
  ) {
    mindMap.renderer.setNodeStyles(node, { ...backup })
    node.reRender?.()
  }
  delete node.__flowExpandStyleBackup
}
export function syncFlowExpandVisuals(mindMap, jobs) {
  for (const job of jobs || []) {
    if (job.nodeUid) {
      legacyUids.add(job.nodeUid)
      restore(mindMap, job.nodeUid)
    }
  }
}
export function clearAllFlowExpandVisuals(mindMap) {
  for (const uid of legacyUids) restore(mindMap, uid)
  legacyUids.clear()
}
export function focusFlowExpandNode(mindMap, uid) {
  if (mindMap && uid) mindMap.execCommand('GO_TARGET_NODE', uid)
}
