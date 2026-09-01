const Y = require('yjs')

const clone = value =>
  value === undefined ? value : JSON.parse(JSON.stringify(value))
const isYMap = value => value instanceof Y.Map
const isYArray = value => value instanceof Y.Array
const isYText = value => value instanceof Y.Text

function createYText(value) {
  const text = new Y.Text()
  if (value) text.insert(0, String(value))
  return text
}

function looksLikeHtml(value) {
  return /<\/?[a-z][\s\S]*>/i.test(String(value || ''))
}

function syncText(text, nextValue, previousValue) {
  const next = String(nextValue || '')
  const current = text.toString()
  if (current === next) return
  const snapshot = String(previousValue || '')
  const staleSnapshot = snapshot !== current
  if (staleSnapshot || looksLikeHtml(current) || looksLikeHtml(next)) {
    if (current.length) text.delete(0, current.length)
    if (next) text.insert(0, next)
    return
  }
  const previous = current
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

function insertChild(children, uid, desired, index) {
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

function reconcileChildren(children, nextList = [], previousList = []) {
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
    if ((!previousSet.has(uid) || reordered) && !children.toArray().includes(uid)) {
      insertChild(children, uid, next, index)
    }
  })
}

function sameList(a = [], b = []) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function sameJson(a, b) {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

function nodeUnchanged(nextNode = {}, previousNode) {
  if (!previousNode) return false
  return (
    !!nextNode.isRoot === !!previousNode.isRoot &&
    String(nextNode.position || '') === String(previousNode.position || '') &&
    sameList(nextNode.children, previousNode.children) &&
    sameJson(nextNode.data, previousNode.data)
  )
}

function createNodeMap(node = {}) {
  const nodeMap = new Y.Map()
  const dataMap = new Y.Map()
  const children = new Y.Array()
  nodeMap.set('isRoot', !!node.isRoot)
  if (node.position) nodeMap.set('position', String(node.position))
  Object.keys(node.data || {}).forEach(key => {
    const value = node.data[key]
    dataMap.set(
      key,
      key === 'text' && typeof value === 'string' ? createYText(value) : clone(value)
    )
  })
  if (node.children && node.children.length) children.push([...node.children])
  nodeMap.set('data', dataMap)
  nodeMap.set('children', children)
  return nodeMap
}

function ensureNodeMap(ymap, uid, node) {
  let nodeMap = ymap.get(uid)
  if (!isYMap(nodeMap)) {
    nodeMap = createNodeMap(node)
    ymap.set(uid, nodeMap)
  }
  if (!isYMap(nodeMap.get('data'))) nodeMap.set('data', new Y.Map())
  if (!isYArray(nodeMap.get('children'))) nodeMap.set('children', new Y.Array())
  return nodeMap
}

function syncDataMap(dataMap, nextData = {}, previousData = {}) {
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
    if (JSON.stringify(previousData[key]) !== JSON.stringify(nextData[key])) {
      dataMap.set(key, clone(nextData[key]))
    }
  })
}

function applyObjectToDoc(
  ydoc,
  nextObject,
  { replace = false, previousObject = null, deleteUids = null } = {}
) {
  const ymap = ydoc.getMap()
  const previous = previousObject || ymap.toJSON()
  ydoc.transact(() => {
    Object.keys(nextObject).forEach(uid => {
      const nextNode = nextObject[uid]
      const previousNode = previous[uid]
      if (!replace && nodeUnchanged(nextNode, previousNode)) return
      const nodeMap = ensureNodeMap(ymap, uid, nextNode)
      const isRoot = !!nextNode.isRoot
      if (nodeMap.get('isRoot') !== isRoot) {
        nodeMap.set('isRoot', isRoot)
      }
      const position = nextNode.position == null ? '' : String(nextNode.position)
      if (String(nodeMap.get('position') || '') !== position) {
        if (position) nodeMap.set('position', position)
        else if (nodeMap.has('position')) nodeMap.delete('position')
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
      : Object.keys(previous).filter(uid => !nextObject[uid])
    deletions.forEach(uid => {
      if (ymap.has(uid)) ymap.delete(uid)
    })
    if (replace) {
      Array.from(ymap.keys()).forEach(uid => {
        if (!nextObject[uid]) ymap.delete(uid)
      })
    }
  }, 'mind-api')
}

module.exports = { applyObjectToDoc, reconcileChildren }
