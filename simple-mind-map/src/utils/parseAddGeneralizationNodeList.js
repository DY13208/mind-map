/* global module:readonly */

// 去掉「整次选择的共同祖先」。框选两支时父节点/根节点容易被圈进去，
// 但不能把选区拆成各支下面的叶子分别加概要。
function excludeCommonAncestorsOfEntireSelection(list) {
  let nodes = Array.isArray(list) ? list.filter(Boolean) : []
  let changed = true
  while (changed) {
    changed = false
    const next = nodes.filter(node => {
      const others = nodes.filter(item => item && item.uid !== node.uid)
      if (!others.length) return true
      const isCommonAncestor = others.every(item => {
        return typeof node.isAncestor === 'function' && node.isAncestor(item)
      })
      if (isCommonAncestor) changed = true
      return !isCommonAncestor
    })
    nodes = next
  }
  return nodes
}

// 只保留顶层被选中的节点，子树被圈中时仍以这支的根为准
function getTopAncestorsFomNodeList(list) {
  const nodes = Array.isArray(list) ? list.filter(Boolean) : []
  return nodes.filter(node => {
    return !nodes.some(item => {
      return (
        item &&
        item.uid !== node.uid &&
        typeof item.isAncestor === 'function' &&
        item.isAncestor(node)
      )
    })
  })
}

function collectContiguousRanges(indexList) {
  const sorted = Array.from(new Set(indexList)).sort((a, b) => a - b)
  if (!sorted.length) return []
  const ranges = []
  let start = sorted[0]
  let end = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i]
    } else {
      ranges.push([start, end])
      start = sorted[i]
      end = sorted[i]
    }
  }
  ranges.push([start, end])
  return ranges
}

function findNodeByBrotherIndex(group, index) {
  return group.find(item => item.index === index)
}

// 解析要添加概要的节点实例列表
function parseAddGeneralizationNodeList(list) {
  const targets = getTopAncestorsFomNodeList(
    excludeCommonAncestorsOfEntireSelection(list)
  )
  const cache = {}
  const uidToParent = {}
  targets.forEach(node => {
    const parent = node.parent
    if (!parent) return
    const pUid = parent.uid
    uidToParent[pUid] = parent
    const index = node.getIndexInBrothers()
    const data = {
      node,
      index
    }
    if (cache[pUid]) {
      if (!cache[pUid].find(item => item.index === data.index)) {
        cache[pUid].push(data)
      }
    } else {
      cache[pUid] = [data]
    }
  })
  const res = []
  Object.keys(cache).forEach(uid => {
    const group = cache[uid]
    if (group.length > 1) {
      const ranges = collectContiguousRanges(group.map(item => item.index))
      ranges.forEach(range => {
        if (range[0] === range[1]) {
          const item = findNodeByBrotherIndex(group, range[0])
          if (item) res.push({ node: item.node })
          return
        }
        res.push({
          node: uidToParent[uid],
          range
        })
      })
    } else {
      res.push({
        node: group[0].node
      })
    }
  })
  return res
}

const api = {
  excludeCommonAncestorsOfEntireSelection,
  excludeSelectedAncestorsFromNodeList: excludeCommonAncestorsOfEntireSelection,
  getTopAncestorsFomNodeList,
  parseAddGeneralizationNodeList
}

module.exports = api
module.exports.default = api
