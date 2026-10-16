'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const directPolicy = require('../simple-mind-map/bin/mcpDirectPolicy')

const apiPath = path.join(__dirname, '..', 'simple-mind-map', 'bin', 'mindApi.js')
const apiSource = fs.readFileSync(apiPath, 'utf8')
const functionStart = apiSource.indexOf(
  'async function executeDirectOperation('
)
const functionEnd = apiSource.indexOf('\nasync function executeOperation(', functionStart)
assert.ok(functionStart >= 0, 'executeDirectOperation exists in mindApi.js')
assert.ok(functionEnd > functionStart, 'executeDirectOperation has a bounded source range')
const functionSource = apiSource.slice(functionStart, functionEnd).trim()

function makeEntry(overrides = {}) {
  const state = {
    queries: [],
    commits: 0,
    applied: 0,
    classifications: 0,
    queryError: null,
    rows: [],
    applyError: null,
    policy: {
      ...directPolicy,
      classifyMcpDirectReferences(...args) {
        state.classifications += 1
        return directPolicy.classifyMcpDirectReferences(...args)
      }
    },
    ...overrides
  }

  const sandbox = {
    Set,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    Promise,
    require(id) {
      if (id === './mcpDirectPolicy') return state.policy
      if (id === './collabV2/flag') {
        return {
          isCollabV2Enabled: () => true,
          isCollabV2EventBridgeEnabled: () => true,
          envFlag: () => true
        }
      }
      if (id === './collabV2/directStore') {
        return {
          createPgStore() {
            return { setMeta() {}, stats: { queries: 0 } }
          }
        }
      }
      if (id === './collabV2/directApplier') {
        return {
          async applyDirect() {
            state.applied += 1
            if (state.applyError) throw state.applyError
            return { result: { applied: true }, noop: false }
          }
        }
      }
      throw new Error(`Unexpected require in isolated entry: ${id}`)
    },
    getRoomMeta: async () => ({ room_nodes_initialized: true }),
    mcpDirectFallbackReason: () => null,
    getPool: () => ({
      async query(sql, params) {
        state.queries.push({ sql, params })
        if (state.queryError) throw state.queryError
        return { rows: state.rows }
      }
    }),
    assertRoomWritable() {},
    assertRateLimit() {},
    assertBatchSize() {},
    assertPatchSize() {},
    withRoomMutation: async (_roomKey, mutation) => mutation(),
    async commitDirectRoomOperation(_roomKey, _command, mutate) {
      state.commits += 1
      return mutate({ client: {}, room: { metadata: {} }, currentVersion: 4 })
    },
    invalidateRoomCache() {},
    dropLiveDoc() {}
  }

  vm.runInNewContext(
    `${functionSource}\nthis.executeDirectOperation = executeDirectOperation`,
    sandbox,
    { filename: 'mindApi.executeDirectOperation.vm.js' }
  )
  return { state, execute: sandbox.executeDirectOperation }
}

const mcpSource = { principalId: 'verified-entry-test' }
const mcpRequest = { v: 1, principalId: mcpSource.principalId, digest: 'entry-test-digest' }
const uuid = '550e8400-e29b-41d4-a716-446655440001'
const update = uid => ({ type: 'node.update', operationId: 'op-entry-test', payload: { uid, patch: { text: 'updated' } } })
const rejectedByExecutor = Object.assign(new Error('node not found'), { code: 'NODE_NOT_FOUND' })

async function main() {
  {
    const entry = makeEntry({ rows: [{ uid: uuid }] })
    const result = await entry.execute('room-entry-test', update(uuid), mcpSource, mcpRequest)
    assert.equal(result.fallbackReason, null)
    assert.equal(entry.state.commits, 1)
    assert.match(entry.state.queries[0].sql, /uid = any\(\$2::text\[\]\)/)
    assert.doesNotMatch(entry.state.queries[0].sql, /deleted_at\s+is\s+null/i,
      'MCP proof includes tombstoned rows')
    assert.deepEqual(JSON.parse(JSON.stringify(entry.state.queries[0].params)), ['room-entry-test', [uuid]])
    assert.equal(entry.state.classifications, 1)
  }

  {
    const entry = makeEntry({ applyError: rejectedByExecutor })
    await assert.rejects(
      entry.execute('room-entry-test', update(uuid), mcpSource, mcpRequest),
      error => error.code === 'NODE_NOT_FOUND'
    )
    assert.equal(entry.state.commits, 1, 'missing UUID is kept on Direct')
    assert.equal(entry.state.applied, 1, 'Direct executor rejects the missing UUID')
  }

  {
    const move = {
      type: 'node.move',
      operationId: 'op-move-entry-test',
      payload: { uid: '标题/节点路径', parentUid: 'root', index: 0 }
    }
    const entry = makeEntry({ applyError: rejectedByExecutor })
    await assert.rejects(
      entry.execute('room-entry-test', move, mcpSource, mcpRequest),
      error => error.code === 'NODE_NOT_FOUND'
    )
    assert.equal(entry.state.commits, 1, 'explicit move remains on Direct')
    assert.equal(entry.state.applied, 1, 'Direct executor rejects its missing UID')
    assert.deepEqual(JSON.parse(JSON.stringify(entry.state.queries[0].params)), ['room-entry-test', ['标题/节点路径']])
  }

  {
    const dbError = Object.assign(new Error('database unavailable'), { code: '08006' })
    const entry = makeEntry({ queryError: dbError })
    await assert.rejects(
      entry.execute('room-entry-test', update(uuid), mcpSource, mcpRequest),
      error =>
        error.code === 'MCP_DIRECT_REFERENCE_UNAVAILABLE' &&
        error.statusCode === 503 &&
        error.details.fallbackReason === 'uid_proof_query_failed'
    )
    assert.equal(entry.state.commits, 0, 'proof failure cannot fall back to legacy write')
  }

  {
    const entry = makeEntry({ rows: [{ uid: uuid }] })
    const result = await entry.execute('room-entry-test', update(uuid), mcpSource, mcpRequest)
    assert.equal(result.committed.result.applied, true, 'a proven live UID reaches Direct')
    assert.equal(entry.state.applied, 1)
  }

  {
    const entry = makeEntry()
    const result = await entry.execute(
      'room-entry-test', update('业务标题/节点路径'), mcpSource, mcpRequest
    )
    assert.equal(result.committed, null)
    assert.equal(result.fallbackReason, 'direct_policy_unsupported',
      'legacy title/path references remain eligible for the compatibility writer')
    assert.equal(entry.state.commits, 0)
    assert.equal(entry.state.classifications, 1)
  }

  {
    const originalError = Object.assign(new Error('HTTP proof failed'), { code: 'HTTP_DB_ERROR' })
    const entry = makeEntry({ queryError: originalError })
    await assert.rejects(
      entry.execute('room-entry-test', update(uuid), null, null, 'http-editor'),
      error => error === originalError && error.code === 'HTTP_DB_ERROR'
    )
    assert.match(entry.state.queries[0].sql, /deleted_at\s+is\s+null/i,
      'HTTP proof remains live-only')
    assert.equal(entry.state.classifications, 0, 'HTTP does not use MCP classification')
    assert.equal(entry.state.commits, 0)
  }

  {
    const entry = makeEntry()
    const result = await entry.execute(
      'room-entry-test', update(uuid), null, null, 'http-editor'
    )
    assert.equal(result.committed, null,
      'HTTP must not accept a missing UID for the Direct path')
    assert.equal(result.fallbackReason, 'direct_policy_unsupported')
    assert.match(entry.state.queries[0].sql, /deleted_at\s+is\s+null/i)
    assert.equal(entry.state.commits, 0)
  }

  {
    const entry = makeEntry()
    const batch = {
      type: 'node.batch',
      operationId: 'op-batch-entry-test',
      payload: { ops: [{ type: 'node.update', payload: { uid: 'node-a', patch: { text: 'x' } } }] }
    }
    const result = await entry.execute('room-entry-test', batch, mcpSource, mcpRequest)
    assert.equal(result.fallbackReason, null)
    assert.equal(entry.state.queries.length, 0, 'batch proof and write logic is unchanged')
    assert.equal(entry.state.commits, 1)
  }

  console.log('MCP Direct 真实入口 UID 证明、墓碑、缺失引用、move、SQL错误、legacy回退及HTTP兼容检查通过')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
