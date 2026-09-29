/**
 * Diff Wiki desired tree vs Mindmap current subtree.
 * Identity is nodeId only — never title / index matching for UPDATE.
 *
 * CREATE policy: unmarked headings are CREATE only when every existing mindmap
 * node under the branch is referenced by a marker in the Wiki tree (no ambiguity).
 * Otherwise UNMAPPED_NODE / VALIDATION_FAILED.
 */

function indexTree(node, map = new Map()) {
  if (!node) return map
  const id = node.nodeId || node.uid
  if (id) map.set(id, node)
  ;(node.children || []).forEach(c => indexTree(c, map))
  return map
}

function normalizeNote(node) {
  if (!node) return ''
  if (node.note != null && node.note !== undefined) return String(node.note)
  return String(node.content || '')
}

/**
 * @param {object} desired - wiki parse root (nodeId may be null for CREATE)
 * @param {object} current - mindmap subtree root (uid/nodeId set)
 * @param {{ branchRootUid: string }} opts
 */
function diffTrees(desired, current, opts = {}) {
  const branchRootUid = opts.branchRootUid || (current && (current.uid || current.nodeId))
  const allowMove = opts.allowMove !== false
  const allowDelete = opts.allowDelete !== false
  const ops = { create: [], update: [], delete: [], move: [] }
  const errors = []
  const skippedMoves = []
  const skippedDeletes = []
  const conflicts = []

  if (!desired) {
    return {
      ok: false,
      error: 'VALIDATION_FAILED',
      errors: [{ code: 'EMPTY_DESIRED' }],
      ops,
      unmapped: 0
    }
  }
  if (!current || !branchRootUid) {
    return {
      ok: false,
      error: 'VALIDATION_FAILED',
      errors: [{ code: 'MISSING_BRANCH_ROOT' }],
      ops,
      unmapped: 0
    }
  }

  // Bind wiki root to branch root (mapping is authoritative for root identity)
  if (!desired.nodeId) {
    desired.nodeId = branchRootUid
  } else if (desired.nodeId !== branchRootUid) {
    // Marker on H1 must match branch root when present
    errors.push({
      code: 'ROOT_ID_MISMATCH',
      expected: branchRootUid,
      got: desired.nodeId
    })
  }

  const currentIndex = indexTree(current)
  const desiredIndex = indexTree(desired)

  // Duplicate ids already handled by parser; double-check desired
  const seen = new Set()
  for (const id of desiredIndex.keys()) {
    if (seen.has(id)) {
      errors.push({ code: 'DUPLICATE_NODE_ID', nodeId: id })
    }
    seen.add(id)
  }

  // Unknown markers → validation failure (do not invent / title-match)
  for (const [id] of desiredIndex) {
    if (id === branchRootUid) continue
    if (!currentIndex.has(id)) {
      errors.push({ code: 'UNKNOWN_NODE_ID', nodeId: id })
    }
  }

  // Re-collect unmarked after root bind
  const unmarkedNodes = []
  function walkUnmarked(n, isRoot) {
    if (!isRoot && !n.nodeId) unmarkedNodes.push(n)
    ;(n.children || []).forEach(c => walkUnmarked(c, false))
  }
  walkUnmarked(desired, true)

  const currentIds = new Set(
    [...currentIndex.keys()].filter(id => id !== branchRootUid)
  )
  const desiredMappedIds = new Set(
    [...desiredIndex.keys()].filter(id => id !== branchRootUid)
  )

  const missingFromWiki = [...currentIds].filter(id => !desiredMappedIds.has(id))

  // Ambiguity: mindmap nodes missing from wiki markers AND unmarked headings exist
  if (missingFromWiki.length && unmarkedNodes.length) {
    return {
      ok: false,
      error: 'UNMAPPED_NODE',
      errors: [
        {
          code: 'UNMAPPED_NODE',
          missingMarkers: missingFromWiki,
          unmarkedCount: unmarkedNodes.length
        }
      ],
      ops,
      unmapped: unmarkedNodes.length,
      success: false
    }
  }

  // Unmarked headings with full coverage of existing nodes → CREATE
  // Unmarked when current has zero children → CREATE (bootstrap children)
  // Unmarked when missingFromWiki empty → CREATE
  if (unmarkedNodes.length && missingFromWiki.length === 0) {
    // ok — CREATE path below
  } else if (unmarkedNodes.length) {
    return {
      ok: false,
      error: 'UNMAPPED_NODE',
      errors: [{ code: 'UNMAPPED_NODE', unmarkedCount: unmarkedNodes.length }],
      ops,
      unmapped: unmarkedNodes.length,
      success: false
    }
  }

  if (errors.length) {
    return {
      ok: false,
      error: 'VALIDATION_FAILED',
      errors,
      ops,
      unmapped: unmarkedNodes.length
    }
  }

  // Parent map for MOVE detection
  function parentMap(node, parentId = null, acc = new Map()) {
    const id = node.nodeId || node.uid
    if (id) acc.set(id, parentId)
    ;(node.children || []).forEach(c => parentMap(c, id, acc))
    return acc
  }
  const desiredParent = parentMap(desired)
  const currentParent = parentMap(current)

  // UPDATE / MOVE for mapped ids
  for (const [id, dNode] of desiredIndex) {
    const cNode = currentIndex.get(id)
    if (!cNode) continue // CREATE handled separately for unmarked; unknown marked already erred
    const textChanged = String(dNode.text || '') !== String(cNode.text || '')
    const noteChanged = normalizeNote(dNode) !== normalizeNote(cNode)
    if (textChanged || noteChanged) {
      const patch = {}
      if (textChanged) patch.text = String(dNode.text || '')
      if (noteChanged) patch.note = normalizeNote(dNode)
      ops.update.push({ nodeId: id, patch })
    }
    const dp = desiredParent.get(id)
    const cp = currentParent.get(id)
    if (dp && cp && dp !== cp) {
      if (allowMove) {
        ops.move.push({ nodeId: id, parentUid: dp })
      } else {
        skippedMoves.push({ nodeId: id, parentUid: dp, reason: 'ALLOW_MOVE_FALSE' })
      }
    }
  }

  // CREATE unmarked (assign temp keys; executor fills real uids)
  function walkCreate(dNode, parentUid) {
    const id = dNode.nodeId
    if (!id) {
      ops.create.push({
        tempKey: `tmp_${ops.create.length}`,
        parentUid,
        text: String(dNode.text || '新节点'),
        note: normalizeNote(dNode),
        wikiNode: dNode
      })
      // children of new node: parent is temp — executor resolves after insert
      const tempParent = ops.create[ops.create.length - 1].tempKey
      ;(dNode.children || []).forEach(c => walkCreate(c, tempParent))
      return
    }
    ;(dNode.children || []).forEach(c => walkCreate(c, id))
  }
  walkCreate(desired, branchRootUid)

  // DELETE: in current, not in desired (only when validation passed / no ambiguity)
  for (const id of missingFromWiki) {
    if (allowDelete) {
      ops.delete.push({ nodeId: id })
    } else {
      skippedDeletes.push({ nodeId: id, reason: 'ALLOW_DELETE_FALSE' })
    }
  }

  // Destructive ops require clean validation (already enforced above)
  return {
    ok: true,
    error: null,
    errors: [],
    ops,
    unmapped: 0,
    skippedMoves,
    skippedDeletes,
    counts: {
      create: ops.create.length,
      update: ops.update.length,
      delete: ops.delete.length,
      move: ops.move.length
    }
  }
}

module.exports = { diffTrees, indexTree, normalizeNote }
