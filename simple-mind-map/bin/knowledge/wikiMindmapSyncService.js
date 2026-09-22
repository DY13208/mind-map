/**
 * Wiki → Mindmap reverse sync (human slot only).
 * Phase A analyze → Phase B execute. No replace_tree.
 */
const crypto = require('crypto')
const mappingStore = require('./docmostMappingStore')
const {
  parseMarkdownToTree,
  mindmapSubtreeToTree,
  subtreeHash,
  contentHash,
  rootUidFromTopicKey,
  rewriteMarkdownWithMarkers,
} = require('./wikiMindmapMarkdown')
const { diffTrees } = require('./wikiMindmapDiff')
const docmostClient = require('./adapters/docmostClient')
const { toDocmostMarkdown } = require('./adapters/docmostAdapter')

function logSync(fields) {
  const parts = Object.keys(fields)
    .filter(k => fields[k] !== undefined && fields[k] !== null)
    .map(k => `${k}=${fields[k]}`)
  console.log('[WikiMindmapSync] ' + parts.join(' '))
}

function fail(error, extra = {}) {
  return { success: false, error, ...extra }
}

async function loadWikiPageMarkdown(pageId, env = process.env) {
  const auth = await docmostClient.ensureSyncAuth(env)
  const page = await docmostClient.request('/api/pages/info', {
    cookie: auth.cookie,
    body: { pageId: String(pageId), format: 'markdown' },
    env
  })
  if (!page) {
    const err = new Error('Wiki page not found')
    err.code = 'WIKI_PAGE_NOT_FOUND'
    err.statusCode = 404
    throw err
  }
  const body =
    typeof page.content === 'string'
      ? page.content
      : page.content == null
        ? ''
        : String(page.content)
  return {
    page,
    markdown: body,
    title: page.title || '',
    auth
  }
}

async function writeWikiMarkdown(auth, { pageId, title, markdown, env }) {
  const body = toDocmostMarkdown(markdown, {
    preserveMindmapMarkers: true,
    env
  })
  // Keep ownership marker if present in source; prepend human ownership if missing
  const ownership = mappingStore.parseOwnershipMarker(markdown)
  let out = body
  if (ownership) {
    out =
      mappingStore.ownershipMarker({
        roomId: ownership.roomId,
        topicKey: ownership.topicKey,
        slot: ownership.slot,
        owner: ownership.owner
      }) + out.replace(/^<!--\s*mind-map:ownership[\s\S]*?-->\n?/, '')
  }
  await docmostClient.request('/api/pages/update', {
    cookie: auth.cookie,
    body: {
      pageId,
      title: title || undefined,
      content: out,
      format: 'markdown',
      operation: 'replace'
    },
    env
  })
  return out
}

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {(roomId: string) => Promise<{nodes: object, version?: number}>} deps.loadRoomNodes
 * @param {(roomId: string, command: object) => Promise<object>} deps.executeCommand
 * @param {object} [deps.env]
 */
function createWikiMindmapSyncService(deps) {
  const {
    pool,
    loadRoomNodes,
    executeCommand,
    env = process.env,
    writeBackMarkers = true
  } = deps

  async function syncPageToMindmap({
    pageId,
    actorId = 'wiki-sync',
    allowMove = true,
    allowDelete = true
  } = {}) {
    const started = Date.now()
    const page_id = String(pageId || '').trim()
    if (!page_id) return fail('MISSING_PAGE_ID')

    await mappingStore.ensureSchema(pool)
    const mapping = await mappingStore.getMappingByPageId(pool, page_id)
    if (!mapping) {
      logSync({ page_id, action: 'resolve', status: 'MAPPING_NOT_FOUND' })
      return fail('MAPPING_NOT_FOUND', { page_id })
    }

    const room_id = mapping.room_id
    const topic_key = mapping.topic_key
    const slot = mapping.slot

    if (slot === 'standard') {
      logSync({
        page_id,
        room_id,
        topic_key,
        slot,
        action: 'validate',
        status: 'STANDARD_SLOT_READ_ONLY_FOR_WIKI_TO_MINDMAP'
      })
      return fail('STANDARD_SLOT_READ_ONLY_FOR_WIKI_TO_MINDMAP', {
        page_id,
        room_id,
        topic_key,
        slot
      })
    }
    if (slot !== 'human') {
      return fail('SLOT_NOT_SUPPORTED', { page_id, room_id, topic_key, slot })
    }
    if (mapping.owner !== 'human') {
      return fail('OWNER_NOT_HUMAN', {
        page_id,
        room_id,
        topic_key,
        slot,
        owner: mapping.owner
      })
    }

    // Phase A: load + parse + validate + diff
    const { markdown, title, auth } = await loadWikiPageMarkdown(page_id, env)
    const wikiHash = contentHash(markdown)

    const room = await loadRoomNodes(room_id)
    const nodes = (room && room.nodes) || {}
    const branchRootUid = rootUidFromTopicKey(topic_key, nodes)
    if (!branchRootUid || !nodes[branchRootUid]) {
      return fail('BRANCH_ROOT_NOT_FOUND', {
        page_id,
        room_id,
        topic_key,
        slot
      })
    }

    const currentTree = mindmapSubtreeToTree(nodes, branchRootUid)
    const mindHash = subtreeHash(currentTree)

    // Conflict: both sides changed since last successful sync
    const lastWiki = String(mapping.content_hash || '')
    const lastMind = String(mapping.mindmap_hash || '')
    if (lastWiki && lastMind) {
      const wikiChanged = wikiHash !== lastWiki
      const mindChanged = mindHash !== lastMind
      if (wikiChanged && mindChanged) {
        logSync({
          page_id,
          room_id,
          topic_key,
          slot,
          action: 'conflict',
          source: 'wiki',
          status: 'SYNC_CONFLICT',
          duration: Date.now() - started + 'ms'
        })
        return fail('SYNC_CONFLICT', {
          page_id,
          room_id,
          topic_key,
          slot,
          conflicts: [
            {
              code: 'BOTH_SIDES_MODIFIED',
              last_wiki_hash: lastWiki,
              wiki_hash: wikiHash,
              last_mindmap_hash: lastMind,
              mindmap_hash: mindHash
            }
          ]
        })
      }
      // Idempotent: neither changed
      if (!wikiChanged && !mindChanged) {
        logSync({
          page_id,
          room_id,
          topic_key,
          slot,
          action: 'skip',
          source: 'wiki',
          status: 'success',
          duration: Date.now() - started + 'ms'
        })
        return {
          success: true,
          page_id,
          room_id,
          topic_key,
          slot,
          created: 0,
          updated: 0,
          deleted: 0,
          moved: 0,
          skipped: 1,
          conflicts: 0
        }
      }
    }

    const parsed = parseMarkdownToTree(markdown)
    if (parsed.errors.some(e => e.code === 'DUPLICATE_NODE_ID')) {
      logSync({
        page_id,
        room_id,
        topic_key,
        slot,
        action: 'validate',
        status: 'VALIDATION_FAILED',
        duration: Date.now() - started + 'ms'
      })
      return fail('VALIDATION_FAILED', {
        page_id,
        room_id,
        topic_key,
        slot,
        errors: parsed.errors
      })
    }
    if (parsed.errors.length) {
      return fail('VALIDATION_FAILED', {
        page_id,
        room_id,
        topic_key,
        slot,
        errors: parsed.errors
      })
    }

    const diff = diffTrees(parsed.root, currentTree, {
      branchRootUid,
      allowMove,
      allowDelete
    })
    if (!diff.ok) {
      logSync({
        page_id,
        room_id,
        topic_key,
        slot,
        action: 'validate',
        status: diff.error,
        duration: Date.now() - started + 'ms'
      })
      return fail(diff.error || 'VALIDATION_FAILED', {
        page_id,
        room_id,
        topic_key,
        slot,
        unmapped: diff.unmapped || 0,
        errors: diff.errors,
        conflicts: diff.error === 'SYNC_CONFLICT' ? diff.errors : undefined
      })
    }

    if (diff.skippedMoves && diff.skippedMoves.length) {
      logSync({
        page_id,
        room_id,
        topic_key,
        slot,
        action: 'SKIP_MOVE',
        source: 'wiki',
        status: 'skipped',
        count: diff.skippedMoves.length
      })
    }
    if (diff.skippedDeletes && diff.skippedDeletes.length) {
      logSync({
        page_id,
        room_id,
        topic_key,
        slot,
        action: 'SKIP_DELETE',
        source: 'wiki',
        status: 'skipped',
        count: diff.skippedDeletes.length
      })
    }

    const { ops } = diff
    const totalOps =
      ops.create.length +
      ops.update.length +
      ops.delete.length +
      ops.move.length

    // Phase B: execute
    const tempToUid = new Map()
    let created = 0
    let updated = 0
    let deleted = 0
    let moved = 0

    async function run(type, payload) {
      const command = {
        operationId: crypto.randomUUID(),
        mapId: room_id,
        actorId: String(actorId || 'wiki-sync'),
        clientId: 'wiki-mindmap-sync',
        baseVersion: null,
        type,
        payload
      }
      return executeCommand(room_id, command)
    }

    // CREATE (parents before children; resolve temp parents)
    for (const c of ops.create) {
      let parent = c.parentUid
      if (String(parent).startsWith('tmp_')) {
        parent = tempToUid.get(parent)
        if (!parent) {
          return fail('CREATE_PARENT_UNRESOLVED', {
            page_id,
            room_id,
            topic_key,
            slot
          })
        }
      }
      const t0 = Date.now()
      const committed = await run('node.insert', {
        parentUid: parent,
        text: c.text,
        note: c.note || undefined
      })
      const uid =
        (committed &&
          committed.result &&
          (committed.result.uid || committed.result.node_uid)) ||
        (committed &&
          committed.event &&
          committed.event.payload &&
          committed.event.payload.uid)
      if (!uid) {
        return fail('CREATE_FAILED', { page_id, room_id, topic_key, slot })
      }
      tempToUid.set(c.tempKey, uid)
      if (c.wikiNode) c.wikiNode.nodeId = uid
      created += 1
      logSync({
        page_id,
        room_id,
        topic_key,
        slot,
        action: 'CREATE',
        node_id: uid,
        source: 'wiki',
        status: 'success',
        duration: Date.now() - t0 + 'ms'
      })
    }

    for (const u of ops.update) {
      const t0 = Date.now()
      await run('node.update', {
        uid: u.nodeId,
        patch: u.patch
      })
      updated += 1
      logSync({
        page_id,
        room_id,
        topic_key,
        slot,
        action: 'UPDATE',
        node_id: u.nodeId,
        source: 'wiki',
        status: 'success',
        duration: Date.now() - t0 + 'ms'
      })
    }

    for (const m of ops.move) {
      const t0 = Date.now()
      await run('node.move', {
        uid: m.nodeId,
        parentUid: m.parentUid
      })
      moved += 1
      logSync({
        page_id,
        room_id,
        topic_key,
        slot,
        action: 'MOVE',
        node_id: m.nodeId,
        source: 'wiki',
        status: 'success',
        duration: Date.now() - t0 + 'ms'
      })
    }

    // DELETE deepest-first: delete nodes whose descendants are also deleted first
    const deleteSet = new Set(ops.delete.map(d => d.nodeId))
    const orderedDeletes = ops.delete.slice().sort((a, b) => {
      // Prefer deleting children before parents when both listed
      const aNode = nodes[a.nodeId]
      const bNode = nodes[b.nodeId]
      const aKids = (aNode && aNode.children) || []
      const bKids = (bNode && bNode.children) || []
      if (aKids.includes(b.nodeId)) return 1
      if (bKids.includes(a.nodeId)) return -1
      return 0
    })
    // Simple approach: reverse so later siblings/parents last — collect by depth
    function depthOf(uid) {
      let d = 0
      let cur = uid
      const seen = new Set()
      while (cur && !seen.has(cur)) {
        seen.add(cur)
        const parent = Object.keys(nodes).find(id =>
          ((nodes[id] && nodes[id].children) || []).includes(cur)
        )
        if (!parent) break
        d += 1
        cur = parent
      }
      return d
    }
    orderedDeletes.sort((a, b) => depthOf(b.nodeId) - depthOf(a.nodeId))

    for (const d of orderedDeletes) {
      if (!deleteSet.has(d.nodeId)) continue
      const t0 = Date.now()
      await run('node.delete', { uid: d.nodeId })
      deleted += 1
      logSync({
        page_id,
        room_id,
        topic_key,
        slot,
        action: 'DELETE',
        node_id: d.nodeId,
        source: 'wiki',
        status: 'success',
        duration: Date.now() - t0 + 'ms'
      })
    }

    // Write markers back for newly created nodes
    let finalWikiMarkdown = markdown
    if (writeBackMarkers && (created > 0 || totalOps > 0)) {
      finalWikiMarkdown = rewriteMarkdownWithMarkers(markdown, parsed.root)
      // Ensure human ownership marker
      if (!mappingStore.parseOwnershipMarker(finalWikiMarkdown)) {
        finalWikiMarkdown =
          mappingStore.ownershipMarker({
            roomId: room_id,
            topicKey: topic_key,
            slot: 'human',
            owner: 'human'
          }) + finalWikiMarkdown
      }
      try {
        finalWikiMarkdown = await writeWikiMarkdown(auth, {
          pageId: page_id,
          title: title || mapping.title,
          markdown: finalWikiMarkdown,
          env
        })
      } catch (err) {
        logSync({
          page_id,
          room_id,
          topic_key,
          slot,
          action: 'writeback',
          source: 'wiki',
          status: 'error',
          duration: Date.now() - started + 'ms'
        })
        // Mindmap already updated; report partial success with warning
        console.error(
          '[WikiMindmapSync] marker writeback failed: ' +
            ((err && err.message) || err)
        )
      }
    }

    // Reload mind hash after mutations
    const after = await loadRoomNodes(room_id)
    const afterTree = mindmapSubtreeToTree(after.nodes || {}, branchRootUid)
    const afterMindHash = subtreeHash(afterTree)
    const afterWikiHash = contentHash(finalWikiMarkdown)

    await mappingStore.recordWikiMindmapSyncState(pool, {
      roomId: room_id,
      topicKey: topic_key,
      slot: 'human',
      wikiContentHash: afterWikiHash,
      mindmapHash: afterMindHash,
      lastSyncSource: 'wiki',
      title: title || mapping.title
    })

    logSync({
      page_id,
      room_id,
      topic_key,
      slot,
      action: 'sync',
      source: 'wiki',
      status: 'success',
      duration: Date.now() - started + 'ms'
    })

    return {
      success: true,
      page_id,
      room_id,
      topic_key,
      slot,
      created,
      updated,
      deleted,
      moved,
      skipped: 0,
      conflicts: 0,
      skipped_moves: (diff.skippedMoves && diff.skippedMoves.length) || 0,
      skipped_deletes: (diff.skippedDeletes && diff.skippedDeletes.length) || 0
    }
  }

  return { syncPageToMindmap }
}

module.exports = {
  createWikiMindmapSyncService,
  loadWikiPageMarkdown,
  logSync
}
