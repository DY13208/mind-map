const fs = require('node:fs/promises')
const path = require('node:path')
const { KnowledgeCompiler } = require('../knowledge/compiler')
const { readCanonical } = require('../knowledge/adapters/canonicalInput')
const { readSnapshot } = require('../knowledge/snapshot')
const { initSchema } = require('../knowledge/sourceChanges')
const { markdown, renderDocument } = require('../knowledge/markdownRenderer')
const { safeId, hash } = require('../knowledge/utils')
const { publishRoom, removeRoom, readJson, atomicJson } = require('./compiler')
const { parseContractTree, mergeContractSpec, renderTopic } = require('./contracts')
const { SyncScheduler } = require('./scheduler')

function enabled(env = process.env) { return !/^(false|0|no|off)$/i.test(String(env.WIKI_COMPILER_SYNC_ENABLED ?? 'true')) }
class WikiCompiler {
  constructor({ pool, env = process.env, log = console.log }) {
    this.pool = pool; this.env = env; this.log = log
    this.outputDir = path.resolve(env.WIKI_COMPILER_OUTPUT_DIR || path.join(__dirname, '../../../data/wiki-compiler/wiki'))
    this.contractsDir = path.resolve(env.WIKI_COMPILER_CONTRACTS_DIR || path.join(__dirname, '../../../data/contracts'))
    this.compiler = new KnowledgeCompiler({ pool, outputDir: path.join(this.outputDir, '.canonical'), log })
    this.scheduler = new SyncScheduler({ list: () => this.list(), reconcile: id => this.reconcile(id), log,
      intervalMs: Math.max(1, Number(env.WIKI_COMPILER_SYNC_INTERVAL) || 300) * 1000 })
  }
  async initialize() {
    await fs.mkdir(this.outputDir, { recursive: true })
    await this.backupLegacy()
    await initSchema(this.pool)
  }
  async backupLegacy() {
    const marker = path.join(this.outputDir, '.legacy-backup.json')
    if (await readJson(marker)) return
    const names = ['INDEX.md', '.compile-state.json', 'schema.md', 'topics', 'concepts']
    const existing = []
    for (const name of names) if (await fs.stat(path.join(this.outputDir, name)).catch(() => null)) existing.push(name)
    if (!existing.length) return
    const dest = path.join(this.outputDir, '.legacy-backups', new Date().toISOString().replace(/[:.]/g, '-'))
    await fs.mkdir(dest, { recursive: true })
    for (const name of existing) await fs.cp(path.join(this.outputDir, name), path.join(dest, name), { recursive: true })
    await atomicJson(marker, { backup: path.relative(this.outputDir, dest), at: new Date().toISOString() })
    this.log('[WikiCompiler] legacy backup: ' + dest)
  }
  async snapshotContracts(roomId) {
    const input = await readSnapshot(this.pool, roomId, null, { force: true })
    if (input.deleted) return null
    const rows = [...input.model.byUid.values()].map(row => ({ ...row, data: input.data.get(row.uid) || {} }))
    return { input, parsed: parseContractTree(rows) }
  }
  async resolveBinding(rooms) {
    const configured = String(this.env.WIKI_COMPILER_COMPANY_ROOM_ID || '')
    const file = path.join(this.outputDir, '.company-model.json')
    const stored = await readJson(file)
    if (configured) {
      safeId(configured)
      this.companyRoom = configured
      if (stored?.roomId !== configured) await atomicJson(file, { roomId: configured, configured: true })
      return
    }
    if (stored?.roomId) { this.companyRoom = stored.roomId; return }
    const candidates = []
    for (const room of rooms.filter(r => r.title === '公司模型')) {
      try { if ((await this.snapshotContracts(room.room_key))?.parsed) candidates.push(room.room_key) }
      catch (e) { this.log('[WikiCompiler] company candidate failed: ' + e.message) }
    }
    if (candidates.length === 1) {
      this.companyRoom = candidates[0]
      await atomicJson(file, { roomId: this.companyRoom, configured: false })
      this.log('[WikiCompiler] company-model bound: ' + this.companyRoom)
    } else {
      this.companyRoom = null
      this.log('[WikiCompiler] contract supplements paused: set WIKI_COMPILER_COMPANY_ROOM_ID (valid candidates=' + candidates.length + ')')
    }
  }
  async list() {
    const rooms = (await this.pool.query(`select r.room_key, r.title from rooms r left join room_tombstones t using(room_key)
      where r.deleted_at is null and t.room_key is null order by r.room_key`)).rows
    await this.resolveBinding(rooms)
    const live = new Set(rooms.map(r => r.room_key))
    const published = await fs.readdir(path.join(this.outputDir, 'rooms')).catch(e => { if (e.code === 'ENOENT') return []; throw e })
    for (const id of published) if (!live.has(id)) await removeRoom(this.outputDir, id)
    this.log('[WikiCompiler] reconcile rooms=' + rooms.length)
    return [...live]
  }
  async loadSupplements() {
    const files = (await fs.readdir(this.contractsDir).catch(e => { if (e.code === 'ENOENT') return []; throw e })).filter(f => f.endsWith('.json')).sort()
    const specs = []
    for (const file of files) specs.push({ file, spec: JSON.parse(await fs.readFile(path.join(this.contractsDir, file), 'utf8')) })
    return specs
  }
  async reconcile(roomId) {
    safeId(roomId)
    const client = await this.pool.connect()
    const key = 'wiki-compiler:' + this.outputDir + ':' + roomId
    let locked = false
    try {
      locked = !!(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [key])).rows[0].locked
      if (!locked) return
      return await this.reconcileLocked(roomId)
    } finally {
      if (locked) await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [key]).catch(() => {})
      client.release()
    }
  }
  async reconcileLocked(roomId) {
    safeId(roomId)
    const result = await this.compiler.compile(roomId)
    if (result.status === 'archived') { await removeRoom(this.outputDir, roomId); return }
    if (result.status !== 'idle') throw new Error('canonical not ready: ' + result.status)
    let canonical
    try { canonical = await readCanonical(this.compiler.outputDir, roomId) }
    catch (_) {
      await this.compiler.compile(roomId, { force: true })
      canonical = await readCanonical(this.compiler.outputDir, roomId)
    }
    const meta = (await this.pool.query(`select r.title, r.version, coalesce(s.revision,0) as revision
      from rooms r left join room_tombstones t using(room_key) left join knowledge_source_state s using(room_key)
      where r.room_key=$1 and r.deleted_at is null and t.room_key is null`, [roomId])).rows[0]
    if (!meta) { await removeRoom(this.outputDir, roomId); return }
    if (Number(meta.version) !== Number(canonical.manifest.lastCompiledVersion) || Number(meta.revision) !== Number(canonical.manifest.lastSourceRevision)) {
      this.scheduler.notify(roomId); return
    }
    const rootUid = Object.keys(canonical.manifest.nodes).find(uid => canonical.manifest.nodes[uid].path === 'README.md') || 'root'
    const title = meta.title || '未命名脑图'
    let topics = canonical.documents.map(doc => {
      const body = doc.text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
      const nodeUid = doc.rootUid || rootUid
      return { nodeUid, title: doc.file === 'README.md' ? '概览' : (body.match(/^# (.+)$/m)?.[1] || '未命名主题'),
        parentUid: doc.file === 'README.md' ? null : rootUid, markdown: body }
    })
    let supplementHash = ''
    if (roomId === this.companyRoom) {
      const specs = await this.loadSupplements()
      supplementHash = hash(specs)
      const snapshot = await this.snapshotContracts(roomId)
      if (!snapshot || snapshot.input.snapshotVersion !== Number(meta.version) || snapshot.input.sourceRevision !== Number(meta.revision)) {
        this.scheduler.notify(roomId); return
      }
      if (!snapshot.parsed) {
        this.log('[WikiCompiler] contract supplements paused: contract tree missing room=' + roomId)
      } else {
        const { input, parsed } = snapshot
        for (const { file, spec } of specs) mergeContractSpec(parsed.categories, spec, file)
        const owner = input.model.owner.get(parsed.anchorUid)
        // If the contract subtree sits inside a larger branch, re-render that branch with the subtree removed.
        if (owner && owner !== input.model.rootUid) {
          if (owner === parsed.anchorUid) topics = topics.filter(t => t.nodeUid !== owner)
          else {
            const children = new Map(input.model.children)
            for (const [uid, list] of children) children.set(uid, list.filter(child => child !== parsed.anchorUid))
            const rendered = renderDocument({ ...input, model: { ...input.model, children } }, owner, null)
            const topic = topics.find(t => t.nodeUid === owner)
            if (topic) topic.markdown = rendered.text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
          }
        }
        const overview = topics.find(t => t.nodeUid === rootUid)
        if (overview) overview.markdown = overview.markdown.replace(/^- \[[^\n]*\]\(branches\/[^\n]*\)$/gm, '').trim()
        topics.push(...parsed.categories.map(category => ({ nodeUid: category.nodeUid || 'contract-json-' + hash(category.分类).slice(0, 24),
          title: category.分类, parentUid: rootUid, markdown: renderTopic(category, '').replace(/^---\n[\s\S]*?\n---\n/, '').trim() })))
      }
    }
    const latest = (await this.pool.query(`select r.version, coalesce(s.revision,0) as revision from rooms r
      left join room_tombstones t using(room_key) left join knowledge_source_state s using(room_key)
      where r.room_key=$1 and r.deleted_at is null and t.room_key is null`, [roomId])).rows[0]
    if (!latest) { await removeRoom(this.outputDir, roomId); return }
    if (Number(latest.version) !== Number(meta.version) || Number(latest.revision) !== Number(meta.revision)) {
      this.scheduler.notify(roomId); return
    }
    const published = await publishRoom(this.outputDir, { roomId, title, version: Number(meta.version), revision: Number(meta.revision), supplementHash, topics })
    if (published.changed) this.log(`[WikiCompiler][room=${roomId}] version=${meta.version} generation=${published.generation} topics=${topics.length}`)
  }
  async start({ operationEvents, bus } = {}) {
    await this.initialize()
    const notify = event => this.scheduler.notify(event.roomKey || event.roomId || event.mapId)
    this.notify = notify; this.operationEvents = operationEvents
    operationEvents?.on('committed', notify); operationEvents?.on('roomDeleted', notify)
    this.unsubscribe = bus?.subscribe?.(notify)
    try {
      this.sourceClient = await this.pool.connect()
      this.sourceClient.on('notification', event => { if (event.channel === 'knowledge_events') { try { notify(JSON.parse(event.payload)) } catch (_) {} } })
      this.sourceClient.on('error', e => this.log('[WikiCompiler] source notifications unavailable: ' + e.message))
      await this.sourceClient.query('LISTEN knowledge_events')
    } catch (e) {
      this.sourceClient?.release(true); this.sourceClient = null
      this.log('[WikiCompiler] source listener unavailable; polling continues: ' + e.message)
    }
    this.log('[WikiCompiler] independent sync enabled interval=' + this.scheduler.intervalMs / 1000 + 's')
    // Initial reconciliation must not block collaboration startup.
    this.scheduler.start()
    return this
  }
  async stop() {
    this.operationEvents?.off('committed', this.notify); this.operationEvents?.off('roomDeleted', this.notify)
    if (typeof this.unsubscribe === 'function') this.unsubscribe()
    await this.scheduler.stop()
    if (this.sourceClient) { await this.sourceClient.query('UNLISTEN knowledge_events').catch(() => {}); this.sourceClient.release() }
  }
}
let service
async function start(options) {
  if (!enabled(options.env || process.env)) return null
  service = new WikiCompiler(options)
  return service.start(options)
}
module.exports = { WikiCompiler, enabled, start, getService: () => service }
