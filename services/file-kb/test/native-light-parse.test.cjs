'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createPipeline } = require('../src/pipeline')
const { loadConfig } = require('../src/config')

test('small Markdown retains complete text and XLSX retains structured rows without Docling', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-native-light-'))
  const text = '# 原文\n\n完整中文内容😀\n'.repeat(200)
  const ExcelJS = require('exceljs')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('商品表')
  sheet.addRow(['SKU', 'Price'])
  sheet.addRow(['A-001', 12])
  sheet.addRow(['B-002', 34])
  try {
    await fs.writeFile(path.join(dir, 'sample.md'), text)
    await workbook.xlsx.writeFile(path.join(dir, 'sample.xlsx'))
    for (const ext of ['md', 'xlsx']) {
      const file = { id: 'file-1', ext, name: `sample.${ext}`, size: (await fs.stat(path.join(dir, `sample.${ext}`))).size, storage_key: `sample.${ext}`, run_options: {} }
      const raw = new Map(), inserts = [], stats = []
      const db = { async query(sql, params = []) {
        if (sql.includes('from kb.files f left join')) return { rows: [file] }
        if (sql.includes('select id from kb.parse_runs')) return { rows: [{ id: 'run-1' }] }
        if (sql.startsWith('insert into kb.')) inserts.push({ sql, params })
        if (sql.includes('stats = stats ||')) stats.push(params)
        return { rows: [] }
      } }
      const queue = { withFence: async (_job, fn) => fn(db), complete: async () => {}, enqueue: async () => {} }
      const pipeline = createPipeline({ pool: db, queue, nativeLightParse: true, nativeLightMaxBytes: 2097152,
        storage: { resolveKey: key => path.join(dir, key), writeRaw: async (id, json) => { raw.set(id, json); file.raw_json_key = id; return id }, readRaw: async id => raw.get(id) },
        docling: { convertFile: async () => { throw new Error('Small light files must not invoke Docling') } }, log: () => {} })
      const job = { id: 1, file_id: file.id, run_id: 'run-1', kind: 'parse', attempts: 1, max_attempts: 3, created_at: new Date() }
      assert.equal(await pipeline.process(job), 'parsed')
      if (ext === 'md') assert.equal(raw.get('run-1').nativeBlocks[0].text, text)
      const outcome = await pipeline.process({ ...job, kind: 'structure' })
      assert.ok(['done', 'partial'].includes(outcome), `${ext}: ${outcome}`)
      if (ext === 'xlsx') {
        const records = inserts.filter(x => x.sql.startsWith('insert into kb.records'))
        assert.ok(records.length)
        const values = JSON.stringify(records)
        assert.ok(values.includes('A-001') && values.includes('B-002'))
      }
      assert.ok(stats.some(p => JSON.stringify(p).includes(ext === 'md' ? 'native-markdown' : 'exceljs')))
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('worker tuning uses supported bounds', () => {
  const c = loadConfig({ KB_WORKER_CONCURRENCY: '3', KB_LIGHT_CONCURRENCY: '2', KB_HEAVY_CONCURRENCY: '1', KB_NATIVE_LIGHT_PARSE: 'true', KB_NATIVE_LIGHT_MAX_BYTES: '2097152' })
  assert.equal(c.concurrency, 3)
  assert.equal(c.lightConcurrency, 2)
  assert.equal(c.heavyConcurrency, 1)
  assert.equal(c.nativeLightParse, true)
  assert.equal(c.nativeLightMaxBytes, 2097152)
})

test('disabled or oversized light files keep the Docling path', async () => {
  for (const settings of [
    { ext: 'md', size: 100, nativeLightParse: false },
    { ext: 'md', size: 2097153, nativeLightParse: true },
    { ext: 'xlsx', size: 2097153, nativeLightParse: true }
  ]) {
    const file = { id: 'file-1', name: `sample.${settings.ext}`, storage_key: 'unused', ...settings }
    let calls = 0
    const db = { async query(sql) { return { rows: sql.includes('from kb.files f left join') ? [file] : [] } } }
    const pipeline = createPipeline({ pool: db, queue: { withFence: async (_job, fn) => fn(db), complete: async () => {}, enqueue: async () => {} },
      nativeLightParse: settings.nativeLightParse, nativeLightMaxBytes: 2097152,
      storage: { resolveKey: () => '/tmp/unused', writeRaw: async () => 'raw' },
      docling: { convertFile: async () => { calls++; return { json: {}, status: 'success', errors: [] } } }, log: () => {} })
    assert.equal(await pipeline.process({ id: 1, file_id: file.id, run_id: 'run-1', kind: 'parse', attempts: 1, max_attempts: 3, created_at: new Date() }), 'parsed')
    assert.equal(calls, 1)
  }
})
