const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const filename = path.resolve(__dirname, '../bin/nodeKnowledge/store.js')
const localRequire = createRequire(filename)
const calls = []
class FakeCOS {
  getObject(options, callback) {
    calls.push(options)
    callback(null, { Body: Buffer.from('original bytes') })
  }
}
const moduleRef = { exports: {} }
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  require: name => name === 'cos-nodejs-sdk-v5' ? FakeCOS : localRequire(name),
  module: moduleRef, exports: moduleRef.exports, Buffer, console, setTimeout,
  process: { env: { TENCENT_COS_BUCKET: 'test', TENCENT_COS_REGION: 'test', TENCENT_COS_SECRET_ID: 'test' } }
}, { filename })
const store = moduleRef.exports
const db = { query: async () => ({ rows: [{ id: 'a1', byte_size: 100 * 1024 * 1024, cos_key: 'test/key', file_name: 'large.txt' }] }) }
async function main() {
  await assert.rejects(store.getContentById(db, 'room', 'a1', { maxBytes: 5 * 1024 * 1024 }), { code: 'PREVIEW_TOO_LARGE' })
  assert.equal(calls.length, 0, 'reject oversized preview before contacting object storage')
  const prefix = await store.getContentById(db, 'room', 'a1', { prefixBytes: 262144 })
  assert.equal(calls[0].Range, 'bytes=0-262143', 'fetch only the prefix from COS')
  assert.equal(prefix.truncated, true)
  await store.getContentById(db, 'room', 'a1', { prefixBytes: 100000000 })
  assert.equal(calls[1].Range, 'bytes=0-262143', 'enforce server-side prefix ceiling')
  const full = await store.getContentById(db, 'room', 'a1')
  assert.equal(calls[2].Range, undefined, 'original downloads must stay complete')
  assert.equal(full.buffer.toString(), 'original bytes')
  console.log('Attachment content budget and COS range tests passed')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
