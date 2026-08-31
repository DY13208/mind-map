import * as Y from 'yjs'

const clone = value =>
  value === undefined ? value : JSON.parse(JSON.stringify(value))

const isYMap = value => value instanceof Y.Map
const isYArray = value => value instanceof Y.Array
const isYText = value => value instanceof Y.Text

const createYText = value => {
  const text = new Y.Text()
  if (value) text.insert(0, String(value))
  return text
}

const syncText = (text, nextValue, previousValue) => {
  const next = String(nextValue || '')
  const previous = String(previousValue || '')
  if (text.toString() === next || next === previous) return
  let prefix = 0
  while (
    prefix < previous.length &&
    prefix < next.length &&
    previous[prefix] === next[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const deleteLength = previous.length - prefix - suffix
  const insertValue = next.slice(prefix, next.length - suffix)
  if (deleteLength > 0) text.delete(prefix, deleteLength)
  if (insertValue) text.insert(prefix, insertValue)
}

const insertChild = (children, uid, desired, index) => {
  const current = children.toArray()
  const nextUid = desired.slice(index + 1).find(id => current.includes(id))
  if (nextUid) {
    children.insert(current.indexOf(nextUid), [uid])
    return
  }
  const prevUid = desired
    .slice(0, index)
    .reverse()
    .find(id => current.includes(id))
  if (prevUid) {
    children.insert(current.indexOf(prevUid) + 1, [uid])
    return
  }
  children.push([uid])
}

// 只删除本地快照中明确存在、但新数据中已移除的成员。
// 这样另一个客户端并发插入的 child uid 不会被整数组覆盖掉。
const reconcileChildren = (children, nextList = [], previousList = []) => {
  const next = [...nextList]
  const previous = [...previousList]
  const previousSet = new Set(previous)
  const nextSet = new Set(next)

  previous.forEach(uid => {
    if (nextSet.has(uid)) return
    let index = children.toArray().indexOf(uid)
    while (index !== -1) {
      children.delete(index, 1)
      index = children.toArray().indexOf(uid)
    }
  })

  const previousCommon = previous.filter(uid => nextSet.has(uid))
  const nextCommon = next.filter(uid => previousSet.has(uid))
  const reordered = previousCommon.some((uid, index) => uid !== nextCommon[index])
  if (reordered) {
    nextCommon.forEach(uid => {
      const index = children.toArray().indexOf(uid)
      if (index !== -1) children.delete(index, 1)
    })
  }

  next.forEach((uid, index) => {
    const shouldInsert = !previousSet.has(uid) || reordered
    if (shouldInsert && !children.toArray().includes(uid)) {
      insertChild(children, uid, next, index)
    }
  })
}

const sameList = (a = [], b = []) => {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const sameJson = (a, b) => {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

const nodeUnchanged = (nextNode = {}, previousNode) => {
  if (!previousNode) return false
  return (
    !!nextNode.isRoot === !!previousNode.isRoot &&
    sameList(nextNode.children, previousNode.children) &&
    sameJson(nextNode.data, previousNode.data)
  )
}

const syncDataMap = (dataMap, nextData = {}, previousData = {}) => {
  Object.keys(previousData || {}).forEach(key => {
    if (!(key in nextData)) dataMap.delete(key)
  })
  Object.keys(nextData || {}).forEach(key => {
    if (key === 'text' && typeof nextData[key] === 'string') {
      let text = dataMap.get(key)
      if (!isYText(text)) {
        text = createYText(text === undefined ? previousData[key] : text)
        dataMap.set(key, text)
      }
      syncText(text, nextData[key], previousData[key])
      return
    }
    const value = clone(nextData[key])
    if (JSON.stringify(previousData[key]) !== JSON.stringify(value)) {
      dataMap.set(key, value)
    }
  })
}

const createNodeMap = node => {
  const nodeMap = new Y.Map()
  const dataMap = new Y.Map()
  const children = new Y.Array()
  nodeMap.set('isRoot', !!node.isRoot)
  Object.keys(node.data || {}).forEach(key => {
    const value = node.data[key]
    dataMap.set(key, key === 'text' && typeof value === 'string' ? createYText(value) : clone(value))
  })
  if (node.children && node.children.length) children.push([...node.children])
  nodeMap.set('data', dataMap)
  nodeMap.set('children', children)
  return nodeMap
}

export const migrateLegacyNodes = ymap => {
  ymap.doc.transact(() => {
    Array.from(ymap.entries()).forEach(([uid, node]) => {
      if (!isYMap(node)) {
        ymap.set(uid, createNodeMap(node || {}))
        return
      }
      const dataMap = node.get('data')
      if (isYMap(dataMap)) {
        const text = dataMap.get('text')
        if (typeof text === 'string') dataMap.set('text', createYText(text))
      }
    })
  }, 'cooperate-schema-migration')
}

const ensureNodeMap = (ymap, uid, node) => {
  let nodeMap = ymap.get(uid)
  if (!isYMap(nodeMap)) {
    nodeMap = createNodeMap(node)
    ymap.set(uid, nodeMap)
  }
  if (!isYMap(nodeMap.get('data'))) nodeMap.set('data', new Y.Map())
  if (!isYArray(nodeMap.get('children'))) nodeMap.set('children', new Y.Array())
  return nodeMap
}

export const applyObjectToYMap = (
  ymap,
  nextObject,
  previousObject = {},
  { origin = null, replace = false, deleteUids = null } = {}
) => {
  ymap.doc.transact(() => {
    Object.keys(nextObject).forEach(uid => {
      const nextNode = nextObject[uid]
      const previousNode = previousObject[uid]
      if (!replace && nodeUnchanged(nextNode, previousNode)) return
      const nodeMap = ensureNodeMap(ymap, uid, nextNode)
      const isRoot = !!nextNode.isRoot
      if (nodeMap.get('isRoot') !== isRoot) {
        nodeMap.set('isRoot', isRoot)
      }
      syncDataMap(
        nodeMap.get('data'),
        nextNode.data || {},
        (previousNode && previousNode.data) || {}
      )
      reconcileChildren(
        nodeMap.get('children'),
        nextNode.children || [],
        (previousNode && previousNode.children) || []
      )
    })

    const deletions = Array.isArray(deleteUids)
      ? deleteUids
      : Object.keys(previousObject || {}).filter(uid => !nextObject[uid])
    deletions.forEach(uid => {
      if (ymap.has(uid)) ymap.delete(uid)
    })

    if (replace) {
      Array.from(ymap.keys()).forEach(uid => {
        if (!nextObject[uid]) ymap.delete(uid)
      })
    }
  }, origin)
}
