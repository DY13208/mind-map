'use strict'

/**
 * Repeatable large-map fixtures for C2 benchmarks.
 * `totalNodes` includes the root (e.g. 10000 => 9999 children + root).
 */

function bushTree(totalNodes, prefix = 'n') {
  const count = Math.max(0, Number(totalNodes) - 1)
  const root = {
    data: { uid: 'root', text: 'Root', isRoot: true },
    children: []
  }
  const byUid = { root }
  for (let i = 0; i < count; i++) {
    const uid = prefix + i
    const parentUid = i === 0 ? 'root' : prefix + Math.floor((i - 1) / 8)
    const node = {
      data: { uid, text: 'Node ' + i },
      children: []
    }
    byUid[uid] = node
    byUid[parentUid].children.push(node)
  }
  return { tree: root, nodeCount: count + 1 }
}

function bushObjectGraph(totalNodes, prefix = 'n') {
  const count = Math.max(0, Number(totalNodes) - 1)
  const nodes = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'Root' },
      children: []
    }
  }
  for (let i = 0; i < count; i++) {
    const uid = prefix + i
    const parent = i === 0 ? 'root' : prefix + Math.floor((i - 1) / 8)
    nodes[uid] = {
      data: { uid, text: 'Node ' + i },
      children: []
    }
    nodes[parent].children.push(uid)
  }
  return nodes
}

function treeToMarkdown(tree) {
  const lines = []
  function walk(node, depth) {
    if (!node) return
    const text = String((node.data && node.data.text) || '').replace(/\n/g, ' ')
    lines.push('#'.repeat(Math.min(6, depth + 1)) + ' ' + text)
    const kids = node.children || []
    for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1)
  }
  walk(tree, 0)
  return lines.join('\n')
}

/** Lightweight markdown outline → tree (benchmark stand-in for md import). */
function parseMarkdownOutline(md) {
  const lines = String(md || '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
  const root = { data: { uid: 'root', text: 'Root', isRoot: true }, children: [] }
  const stack = [{ depth: 0, node: root }]
  let seq = 0
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!match) continue
    const depth = match[1].length
    const text = match[2]
    if (depth === 1 && seq === 0) {
      root.data.text = text
      seq += 1
      continue
    }
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop()
    }
    const parent = stack[stack.length - 1].node
    const uid = 'md-' + seq++
    const node = { data: { uid, text }, children: [] }
    parent.children.push(node)
    stack.push({ depth, node })
  }
  return root
}

/** Synthetic XMind-like topic tree (post-parse shape), not a .xmind zip. */
function bushAsXmindTopics(totalNodes) {
  const { tree } = bushTree(totalNodes, 'x')
  function toTopic(node) {
    return {
      title: (node.data && node.data.text) || '',
      children: { attached: (node.children || []).map(toTopic) }
    }
  }
  return {
    title: tree.data.text,
    rootTopic: toTopic(tree)
  }
}

function xmindTopicsToTree(sheet) {
  let seq = 0
  function walk(topic, isRoot) {
    const uid = isRoot ? 'root' : 'xmind-' + seq++
    const node = {
      data: {
        uid,
        text: (topic && topic.title) || '',
        isRoot: !!isRoot
      },
      children: []
    }
    const kids =
      (topic && topic.children && topic.children.attached) ||
      (topic && topic.children) ||
      []
    for (let i = 0; i < kids.length; i++) {
      node.children.push(walk(kids[i], false))
    }
    return node
  }
  return walk(sheet.rootTopic || sheet, true)
}

const SIZES = [1000, 5000, 10000, 20000]

module.exports = {
  SIZES,
  bushTree,
  bushObjectGraph,
  treeToMarkdown,
  parseMarkdownOutline,
  bushAsXmindTopics,
  xmindTopicsToTree
}
