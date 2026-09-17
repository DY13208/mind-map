function createTreeCache(options = {}) {
  const maxEntries = Math.max(4, Number(options.maxEntries) || 32)
  const maxNodes = Math.max(1000, Number(options.maxNodes) || 40000)
  const map = new Map()
  let nodeTotal = 0

  function keyOf(versionId, checksum) {
    return String(versionId || '') + ':' + String(checksum || '')
  }

  function evict() {
    while (map.size > maxEntries || nodeTotal > maxNodes) {
      const first = map.keys().next().value
      if (first == null) break
      const item = map.get(first)
      map.delete(first)
      nodeTotal -= Number((item && item.nodeCount) || 0)
    }
  }

  return {
    get(versionId, checksum) {
      const key = keyOf(versionId, checksum)
      if (!map.has(key)) return null
      const value = map.get(key)
      map.delete(key)
      map.set(key, value)
      return value.payload
    },
    set(versionId, checksum, payload, nodeCount) {
      const key = keyOf(versionId, checksum)
      if (map.has(key)) {
        nodeTotal -= Number(map.get(key).nodeCount || 0)
        map.delete(key)
      }
      const count = Number(nodeCount || 0)
      map.set(key, { payload, nodeCount: count })
      nodeTotal += count
      evict()
    },
    clear() {
      map.clear()
      nodeTotal = 0
    },
    get size() {
      return map.size
    }
  }
}

module.exports = { createTreeCache }
