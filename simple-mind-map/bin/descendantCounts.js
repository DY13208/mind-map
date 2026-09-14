// Count the complete live graph before any preview/depth/page clipping.
// Bottom-up accumulation is O(nodes + edges) and does not limit tree depth.
function countGraphDescendants(childrenByUid) {
  const counts = new Map()
  const pending = new Map()
  const parents = new Map()
  const ready = []
  childrenByUid.forEach((children, uid) => {
    const live = children.filter(id => childrenByUid.has(id))
    counts.set(uid, 0)
    pending.set(uid, live.length)
    if (!live.length) ready.push(uid)
    live.forEach(id => {
      if (!parents.has(id)) parents.set(id, [])
      parents.get(id).push(uid)
    })
  })
  for (let i = 0; i < ready.length; i++) {
    const uid = ready[i]
    ;(parents.get(uid) || []).forEach(parent => {
      counts.set(parent, counts.get(parent) + 1 + counts.get(uid))
      pending.set(parent, pending.get(parent) - 1)
      if (!pending.get(parent)) ready.push(parent)
    })
  }
  if (ready.length !== childrenByUid.size) {
    throw new Error('Cannot count descendants of a cyclic node graph')
  }
  return counts
}

function countObjectDescendants(obj) {
  return countGraphDescendants(new Map(
    Object.keys(obj || {}).map(uid => [uid, obj[uid].children || []])
  ))
}

module.exports = { countGraphDescendants, countObjectDescendants }
