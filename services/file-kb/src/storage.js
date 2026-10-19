'use strict'
// Content-addressed storage under KB_STORAGE_ROOT:
//   objects/<sha[0:2]>/<sha256>   original bytes (immutable, deduped)
//   raw/<run_id>.json             docling JSON per parse run (not stored in PG)
//   tmp/                          in-flight uploads
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')

const KEY_RE = /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f-]{36}$/

function createStorage(root) {
  const abs = path.resolve(root)
  const p = (...x) => path.join(abs, ...x)
  async function init() {
    for (const d of ['objects', 'raw', 'tmp']) await fsp.mkdir(p(d), { recursive: true })
  }
  function keyFor(sha) { return `objects/${sha.slice(0, 2)}/${sha}` }
  function resolveKey(key) {
    if (!KEY_RE.test(key)) throw new Error('invalid storage key')
    return p(...key.split('/'))
  }
  function tmpPath() { return p('tmp', `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.part`) }
  // Move a fully written temp file into CAS; if the object already exists, drop the temp.
  async function commitTemp(tmp, sha) {
    const key = keyFor(sha)
    const dest = resolveKey(key)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    try {
      await fsp.link(tmp, dest)
    } catch (err) {
      if (err.code !== 'EEXIST') {
        // filesystems without hard links: rename (atomic within same fs)
        if (!fs.existsSync(dest)) await fsp.rename(tmp, dest)
      }
    }
    await fsp.rm(tmp, { force: true })
    return key
  }
  function rawKey(runId) {
    if (!UUID_RE.test(runId)) throw new Error('invalid run id')
    return `raw/${runId}.json`
  }
  async function writeRaw(runId, obj) {
    const key = rawKey(runId)
    const dest = p('raw', `${runId}.json`)
    const tmp = `${dest}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(obj))
    await fsp.rename(tmp, dest)
    return key
  }
  async function readRaw(key) {
    const m = /^raw\/([0-9a-f-]{36})\.json$/.exec(key || '')
    if (!m) throw new Error('invalid raw key')
    return JSON.parse(await fsp.readFile(p('raw', `${m[1]}.json`), 'utf8'))
  }
  return { root: abs, init, keyFor, resolveKey, tmpPath, commitTemp, writeRaw, readRaw, rawKey }
}

module.exports = { createStorage }
