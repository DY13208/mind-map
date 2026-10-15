// A content event exposes the existing tree lazily. Consumers that explicitly
// traverse/serialize it pay for that traversal; emitting a delta creates no
// whole-tree snapshot and never exposes renderer back-references.
export function createContentTreeView(root, version) {
  if (!root) return null
  const caches = new Map()
  const wrap = (target, kind = 'value') => {
    if (!target || typeof target !== 'object') return target
    if (!caches.has(kind)) caches.set(kind, new WeakMap())
    const cache = caches.get(kind)
    if (cache.has(target)) return cache.get(target)
    const isRoot = target === root && kind === 'tree'
    let view
    const keys = () => {
      const result = Reflect.ownKeys(target).filter(key => kind !== 'tree' || typeof key !== 'string' || !key.startsWith('_'))
      if (kind === 'data' && !result.includes('isActive')) result.push('isActive')
      if (isRoot && !result.includes('smmVersion')) result.push('smmVersion')
      return result
    }
    view = new Proxy(target, {
      get(object, key) {
        if (kind === 'tree' && typeof key === 'string' && key.startsWith('_')) return undefined
        if (isRoot && key === 'smmVersion') return version
        if (kind === 'data' && key === 'isActive') return false
        const value = Reflect.get(object, key)
        if (key === 'children' && (kind === 'tree' || kind === 'data')) return wrap(value, 'children')
        if (kind === 'tree' && key === 'data') return wrap(value, 'data')
        if (kind === 'data' && key === 'generalization') return wrap(value, Array.isArray(value) ? 'generalizations' : 'data')
        if (Array.isArray(object) && /^\d+$/.test(String(key))) {
          return wrap(value, kind === 'children' ? 'tree' : kind === 'generalizations' ? 'data' : 'value')
        }
        return wrap(value)
      },
      ownKeys: keys,
      has(object, key) { return keys().includes(key) || key in (Object.getPrototypeOf(object) || {}) },
      getOwnPropertyDescriptor(object, key) {
        if (!keys().includes(key)) return undefined
        const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
        if (descriptor && !descriptor.configurable) return descriptor
        return { configurable: true, enumerable: descriptor ? descriptor.enumerable : true, get: () => view[key] }
      },
      set() { throw new TypeError('Content notification tree is read-only') },
      deleteProperty() { throw new TypeError('Content notification tree is read-only') },
      defineProperty() { throw new TypeError('Content notification tree is read-only') }
    })
    cache.set(target, view)
    return view
  }
  return wrap(root, 'tree')
}
