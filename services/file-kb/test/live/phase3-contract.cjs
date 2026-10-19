'use strict'
// Lab-only check for seal, dedup, preview and 429. Never uses mind_map.
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { Pool } = require('pg')
const ExcelJS = require('exceljs')
const lab = process.env.KB_LAB_ROOT
if (!lab || !path.resolve(lab).startsWith('D:\\File-KB-Lab-')) throw new Error('dedicated lab required')
const pool = new Pool({ host: '127.0.0.1', port: 25439, database: 'kb_lab', user: 'postgres', max: 4 })
const { migrate } = require('../../src/migrate')
const { loadConfig } = require('../../src/config')
const { createStorage } = require('../../src/storage')
const { createQueue } = require('../../src/queue')
const { createApi } = require('../../src/api')
const { createHandler } = require('../../src/server')
const { createLimiter } = require('../../src/ratelimit')
const { createWorker } = require('../../src/worker')

async function main() {
  const applied = await migrate(pool, { log: () => {} })
  if (applied.length) throw new Error('lab migrate created versions: ' + applied.join(','))
  const owner = 'phase3-' + Date.now()
  const storage = createStorage(path.join(lab, 'storage', owner))
  await storage.init()
  const config = loadConfig({
    FILE_KB_ENABLED: 'true', KB_STORAGE_ROOT: storage.root, KB_NATIVE_LIGHT_PARSE: 'true',
    KB_UPLOAD_FILES_PER_MINUTE: '4', KB_MAX_QUEUED_PER_USER: '20', KB_POLL_MS: '50'
  })
  const queue = createQueue(pool, { leaseMs: config.leaseMs, maxConcurrent: 2, lightConcurrency: 2, heavyConcurrency: 1 })
  const api = createApi({ pool, storage, queue, config, limiter: createLimiter({ maxConcurrent: 4, perMinute: 4 }) })
  const server = http.createServer(createHandler({
    config, api, query: (t, p) => pool.query(t, p), fetchImpl: fetch,
    authenticator: { authenticate: async () => ({ id: owner }) }
  }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const origin = 'http://127.0.0.1:' + server.address().port
  const log = []
  const ok = (name, detail) => { log.push({ name, detail }); console.log('PASS', name) }
  async function request(p, method = 'GET', body) {
    const r = await fetch(origin + '/api/kb' + p, { method, headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await r.text()
    const b = text ? JSON.parse(text) : {}
    if (!r.ok) throw Object.assign(new Error(JSON.stringify(b)), { status: r.status, body: b, headers: r.headers })
    return b
  }
  async function upload(file, { folderId, batchId, key } = {}) {
    const form = new FormData()
    form.append('file', await fs.openAsBlob(file), path.basename(file))
    const q = new URLSearchParams()
    if (folderId) q.set('folder_id', folderId)
    if (batchId) q.set('batch_id', batchId)
    if (key) q.set('client_key', key)
    const r = await fetch(origin + '/api/kb/files?' + q, { method: 'POST', headers: { Origin: origin }, body: form })
    const b = await r.json()
    return { status: r.status, headers: r.headers, body: b }
  }
  try {
    const health = await request('/health')
    if (!(health.limits && health.limits.maxFileBytes > 0 && Array.isArray(health.limits.allowedExtensions))) throw new Error('limits missing')
    ok('health returns runtime upload limits', health.limits)
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Page')
    for (let n = 1; n <= 30; n++) ws.addRow(['r' + n, n])
    const xlsx = path.join(lab, 'phase3-' + owner + '.xlsx')
    await wb.xlsx.writeFile(xlsx)
    const a = await request('/folders', 'POST', { name: 'A-' + owner })
    const b = await request('/folders', 'POST', { name: 'B-' + owner })
    const first = await upload(xlsx, { folderId: a.id })
    if (first.status !== 201 || first.body.duplicate) throw new Error('first upload ' + JSON.stringify(first.body))
    const layout = await request('/files/' + first.body.id + '/layout?sheet=Page&from_row=20&limit=5')
    const rows = layout.sheets.find(s => s.name === 'Page').preview.map(r => r.row)
    if (JSON.stringify(rows) !== JSON.stringify([20, 21, 22, 23, 24])) throw new Error('preview rows ' + rows.join(','))
    ok('layout page is rows 20-24', { rowCount: layout.sheets.find(s => s.name === 'Page').rowCount })
    const dup = await upload(xlsx, { folderId: b.id })
    if (!dup.body.duplicate || dup.body.id !== first.body.id || dup.body.folderId !== a.id) throw new Error('cross-folder dedup ' + JSON.stringify(dup.body))
    ok('same bytes in another folder return the original file', { id: dup.body.id, folderId: dup.body.folderId })
    await request('/files/' + first.body.id, 'DELETE')
    const again = await upload(xlsx, { folderId: b.id })
    if (again.body.duplicate || again.body.id === first.body.id) throw new Error('soft-delete reupload ' + JSON.stringify(again.body))
    ok('soft-deleted bytes create a new file', { oldId: first.body.id, id: again.body.id })
    const batch = await request('/batches', 'POST', { name: 'partial', expectedCount: 2 })
    const md = path.join(lab, 'phase3-' + owner + '.md')
    fs.writeFileSync(md, '# phase3 ' + owner)
    const item = await upload(md, { batchId: batch.id, key: 'only-one' })
    if (item.status !== 201) throw new Error('batch upload ' + JSON.stringify(item.body))
    const sealed = await request('/batches/' + batch.id + '/seal', 'POST', {})
    if (!sealed.sealed || sealed.received !== 1 || sealed.notUploaded !== 1) throw new Error('seal ' + JSON.stringify(sealed))
    const extra = path.join(lab, 'phase3-extra-' + owner + '.md')
    fs.writeFileSync(extra, '# extra ' + owner)
    const closed = await upload(extra, { batchId: batch.id, key: 'new-after-seal' })
    if (closed.status !== 409 || closed.body.code !== 'batch_closed') throw new Error('expected batch_closed ' + JSON.stringify(closed.body))
    ok('seal stops new files without requiring both planned uploads', sealed)
    const worker = createWorker({
      pool, config, docling: { convertFile: async () => { throw new Error('docling should not be used') } }, log: () => {}
    })
    await worker.start(1)
    const deadline = Date.now() + 20000
    let final
    for (;;) {
      final = await request('/batches/' + batch.id)
      if (final.done === 1 && final.notUploaded === 1 && final.state === 'partial') break
      if (Date.now() > deadline) throw new Error('worker did not finish partial batch ' + JSON.stringify(final))
      await new Promise(r => setTimeout(r, 100))
    }
    await worker.stop(2000)
    ok('lab worker finished the sealed partial batch', { state: final.state, done: final.done, notUploaded: final.notUploaded })
    const limited = await upload(extra, { key: 'over-rate' })
    const wait = Number(limited.body.retryAfterMs)
    const header = limited.headers.get('retry-after')
    if (limited.status !== 429 || limited.body.code !== 'rate_limited' || !(wait > 1000) || header === '1') throw new Error('429 ' + limited.status + ' ' + header + ' ' + JSON.stringify(limited.body))
    ok('rate_limited Retry-After follows the minute window', { retryAfterMs: wait, retryAfter: header })
    fs.writeFileSync(path.join(lab, 'phase3-contract.json'), JSON.stringify(log, null, 2))
  } finally {
    await new Promise(r => server.close(r))
    await pool.end()
  }
}
main().catch(err => { console.error(err); process.exit(1) })
