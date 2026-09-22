const fs = require('fs/promises')
const path = require('path')
const { randomUUID } = require('crypto')
const { safeId, branchPath, hash } = require('./utils')
const store = require('./manifestStore')
const { readSnapshot } = require('./snapshot')
const { renderDocument } = require('./markdownRenderer')
const { ChangeTracker } = require('./changeTracker')

class KnowledgeCompiler {
  constructor(options) {
    this.pool = options.pool
    this.outputDir = path.resolve(options.outputDir)
    this.tracker = options.tracker || new ChangeTracker()
    this.pending = new Map()
    this.errors = new Map()
    /** @type {Map<string, number>} */
    this.failCounts = new Map()
    /** @type {Map<string, number>} */
    this.failCooldownUntil = new Map()
    this.log = options.log || console.log
    this.readSnapshot = options.readSnapshot || readSnapshot
  }
  compileFailCooldownMs(failCount) {
    // Cap at 5 minutes. First failure: 5s, then 10s, 20s, 40s, 80s, 160s, 300s.
    const exp = Math.min(Math.max(0, failCount - 1), 6)
    return Math.min(300000, 5000 * Math.pow(2, exp))
  }
  compile(roomId, options = {}) {
    safeId(roomId)
    const cooldownUntil = this.failCooldownUntil.get(roomId) || 0
    if (Date.now() < cooldownUntil) {
      return Promise.resolve({
        roomId,
        status: 'cooldown',
        reason: this.errors.get(roomId) || 'compile_cooldown',
        cooldownUntil
      })
    }
    if (this.pending.has(roomId)) return this.pending.get(roomId)
    const job = this.run(roomId, options).then(result => {
      this.failCounts.delete(roomId)
      this.failCooldownUntil.delete(roomId)
      return result
    }).catch(err => {
      this.errors.set(roomId, err.message)
      const n = (this.failCounts.get(roomId) || 0) + 1
      this.failCounts.set(roomId, n)
      const ms = this.compileFailCooldownMs(n)
      this.failCooldownUntil.set(roomId, Date.now() + ms)
      this.log(
        `[KnowledgeCompiler][room=${roomId}] failed: ${err.message} (failCount=${n} cooldownMs=${ms})`
      )
      throw err
    }).finally(() => this.pending.delete(roomId))
    this.pending.set(roomId, job)
    return job
  }
  async withLock(roomId, task) {
    const client = await this.pool.connect()
    // A session advisory lock spans short snapshot + filesystem publication,
    // protecting manual/scheduled runs and multiple app instances.
    let locked = false
    try {
      locked = !!(await client.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as locked", ['knowledge:' + this.outputDir + ':' + roomId])).rows[0].locked
      if (!locked) return { roomId, status: 'busy' }
      return await task(client)
    } finally {
      if (locked) await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", ['knowledge:' + this.outputDir + ':' + roomId]).catch(() => {})
      client.release()
    }
  }
  async archive(roomId) {
    const from = path.join(this.outputDir, safeId(roomId))
    await store.recover(from)
    if (!await store.exists(from)) return null
    const trash = path.join(this.outputDir, '.trash')
    await fs.mkdir(trash, { recursive: true, mode: 0o700 })
    const dest = path.join(trash, `${roomId}-${Date.now()}-${randomUUID()}`)
    await fs.rename(from, dest)
    await store.syncDir(this.outputDir)
    return dest
  }
  async run(roomId, options) {
    const started = Date.now()
    return this.withLock(roomId, async client => {
      const roomDir = path.join(this.outputDir, roomId)
      await store.recover(roomDir)
      const previous = await store.readManifest(roomDir)
      const input = await this.readSnapshot(this.pool, roomId, previous, { ...options, snapshotClient: client })
      if (input.deleted) {
        const archivedTo = await this.archive(roomId)
        return { roomId, status: 'archived', archivedTo }
      }
      if (input.noChanges) {
        this.tracker.acknowledge(roomId, input.snapshotVersion)
        this.tracker.acknowledgeSource(roomId, input.sourceRevision)
        return { roomId, status: 'idle', mode: 'incremental', snapshotVersion: input.snapshotVersion,
          lastCompiledVersion: previous.lastCompiledVersion, affectedUids: [], affectedMarkdown: [], changedFiles: [], unchangedFiles: Object.keys(previous.documents).length }
      }
      if (options.afterSnapshot) await options.afterSnapshot(input)
      const next = { version: 1, exportContract: 1, roomId, machineOwned: true,
        lastCompiledVersion: input.snapshotVersion, lastSourceRevision: input.sourceRevision,
        sourceUpdatedAt: input.sourceUpdatedAt, lastCompiledAt: new Date().toISOString(),
        strategy: 'first_level_uid', nodes: { ...(previous?.nodes || {}) }, documents: { ...(previous?.documents || {}) },
        downstream: previous?.downstream || {}, syncVersion: input.snapshotVersion }
      const writes = new Map(), deletes = [], affectedMarkdown = []
      const existingRoots = new Set(input.model.branchRoots)
      // Only remove/reindex metadata from affected documents.
      const affectedPaths = new Set(input.changedRoots.map(branchPath))
      affectedPaths.add('README.md')
      for (const [uid, node] of Object.entries(next.nodes)) if (affectedPaths.has(node.path)) delete next.nodes[uid]
      const roots = [input.model.rootUid, ...input.changedRoots.filter(uid => existingRoots.has(uid))].filter(Boolean)
      for (const rootUid of roots) {
        const file = rootUid === input.model.rootUid ? 'README.md' : branchPath(rootUid)
        const oldDocument = next.documents[file]
        const present = await store.exists(path.join(roomDir, file))
        const valid = present && (!options.force || hash(await fs.readFile(path.join(roomDir, file), 'utf8')) === oldDocument?.fileHash)
        const rendered = renderDocument(input, rootUid, valid ? oldDocument : null)
        Object.assign(next.nodes, rendered.nodes)
        affectedMarkdown.push(file)
        if (!rendered.unchanged) {
          writes.set(file, rendered.text)
          next.documents[file] = { rootUid: file === 'README.md' ? null : rootUid, sourceHash: rendered.sourceHash,
            fileHash: hash(rendered.text), syncVersion: input.snapshotVersion, generatedAt: next.lastCompiledAt }
        }
      }
      // An empty graph still exports an explicit empty README, never stale nodes.
      if (!input.model.rootUid) {
        const text = '# 空导图\n'
        if (next.documents['README.md']?.fileHash !== hash(text)) writes.set('README.md', text)
        next.nodes = {}
        next.documents['README.md'] = { rootUid: null, sourceHash: hash(text), fileHash: hash(text), syncVersion: input.snapshotVersion }
      }
      for (const [file, doc] of Object.entries(next.documents)) if (doc.rootUid && !existingRoots.has(doc.rootUid)) {
        deletes.push(file); delete next.documents[file]
      }
      next.sourceHash = hash(Object.entries(next.documents).map(([file, doc]) => [file, doc.sourceHash]).sort())
      const removed = (await client.query(`select 1 from rooms r left join room_tombstones t using(room_key)
        where r.room_key=$1 and r.deleted_at is null and t.room_key is null`, [roomId])).rows.length === 0
      if (removed) return { roomId, status: 'archived', archivedTo: await this.archive(roomId) }
      await store.publish(roomDir, writes, deletes, next, options)
      this.tracker.acknowledge(roomId, input.snapshotVersion)
      this.tracker.acknowledgeSource(roomId, input.sourceRevision)
      this.errors.delete(roomId)
      const result = { roomId, status: 'idle', mode: input.full ? 'full' : 'incremental', reason: input.reason,
        snapshotVersion: input.snapshotVersion, lastCompiledVersion: next.lastCompiledVersion, sourceRevision: input.sourceRevision,
        affectedUids: input.affectedUids, affectedMarkdown, changedFiles: [...writes.keys()], deletedFiles: deletes,
        unchangedFiles: Object.keys(next.documents).length - writes.size, durationMs: Date.now() - started }
      this.log(`[KnowledgeCompiler][room=${roomId}] version=${input.snapshotVersion} mode=${result.mode} dirty=${input.affectedUids.length} changedFiles=${writes.size} unchangedFiles=${result.unchangedFiles} deletedFiles=${deletes.length} duration=${result.durationMs}ms`)
      return result
    })
  }
  async status(roomId) {
    safeId(roomId)
    // Avoid observing a manifest mid-publication. No node content in status.
    if (this.pending.has(roomId)) return { roomId, status: 'compiling', dirtyNodes: this.tracker.count(roomId) }
    return this.withLock(roomId, async client => {
      const dir = path.join(this.outputDir, roomId)
      await store.recover(dir)
      const manifest = await store.readManifest(dir)
      const last = Number(manifest?.lastCompiledVersion || 0)
      const pendingOps = (await client.query(`select count(*)::int as count from room_operations
        where room_key=$1 and version>$2`, [roomId, last])).rows[0].count
      const current = (await client.query(`select r.version,
        coalesce(s.revision,0) as source_revision from rooms r
        left join knowledge_source_state s using(room_key) where r.room_key=$1`, [roomId])).rows[0]
      return { roomId, status: this.errors.has(roomId) ? 'failed' : 'idle', dirtyNodes: this.tracker.count(roomId),
        pendingOperations: pendingOps, pendingSourceChanges: Math.max(0, Number(current?.source_revision || 0) - Number(manifest?.lastSourceRevision || 0)),
        currentVersion: current ? Number(current.version) : null,
        lastCompiledVersion: manifest?.lastCompiledVersion ?? null, lastSourceRevision: manifest?.lastSourceRevision ?? null,
        lastCompiledAt: manifest?.lastCompiledAt || null, files: Object.keys(manifest?.documents || {}).length,
        error: this.errors.get(roomId) || null }
    })
  }
}
module.exports = { KnowledgeCompiler }
