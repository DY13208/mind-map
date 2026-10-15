'use strict'

function createNodeCountCache({ maxEntries = 256, maxBytes = 4 * 1024 * 1024 } = {}) {
  const entries = new Map()
  let retainedBytes = 0
  const remove = key => {
    const entry = entries.get(key)
    if (!entry) return
    retainedBytes -= entry.bytes
    entries.delete(key)
  }
  return {
    hasPrefix(prefix) {
      for (const key of entries.keys()) if (key.startsWith(prefix)) return true
      return false
    },
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value) {
      // This bounds the encoded payload, not V8's heap allocation. A single
      // enormous scope is simply computed without retaining its counts.
      const encoded = value instanceof Map ? Array.from(value) : value
      const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(encoded))
      if (bytes > maxBytes || maxEntries < 1) return false
      remove(key)
      while (entries.size && (entries.size >= maxEntries || retainedBytes + bytes > maxBytes)) {
        remove(entries.keys().next().value)
      }
      entries.set(key, { value, bytes })
      retainedBytes += bytes
      return true
    }
  }
}

module.exports = { createNodeCountCache }
