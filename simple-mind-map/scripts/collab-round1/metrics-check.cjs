const assert = require('node:assert/strict')
const test = require('node:test')
const { summarize, correlate } = require('./metrics.cjs')
const observer = require('../../bin/collabV2/performanceObserver')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
test('preload refuses any environment outside the isolated database', () => {
  const preload = path.join(__dirname, 'preload.cjs')
  for (const changes of [{ MIND_MAP_SKIP_ROOT_ENV: '0' }, { PGDATABASE: 'production' }, { PGHOST: 'localhost' }]) {
    const result = spawnSync(process.execPath, ['--require', preload, '-e', ''], {
      env: { ...process.env, COLLAB_ROUND1_DIAG: '1', MIND_MAP_SKIP_ROOT_ENV: '1', PGDATABASE: 'diag_collab_round1', PGHOST: 'round1-pg', ...changes }, encoding: 'utf8'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /diagnostic isolation guard rejected environment/)
  }
})
test('empty samples do not imply zero latency or success', () => {
  assert.equal(summarize([]).p99Ms, null)
  assert.equal(summarize([]).failureRate, null)
})
test('failed and censored attempts stay in denominator', () => {
  const result = summarize([{ ok: true, elapsedMs: 5 }, { ok: true, elapsedMs: 20 }, { ok: false, elapsedMs: 1000 }, { ok: true }])
  assert.equal(result.samples, 4); assert.equal(result.failures, 2)
  assert.equal(result.failureRate, .5); assert.equal(result.p99Ms, 20)
})
test('receive is not application; duplicates and missing commits are visible', () => {
  const result = correlate(new Map([['a', { atMs: 10 }]]), [
    { client: 'x', opId: 'a', kind: 'event_received', atMs: 20 },
    { client: 'x', opId: 'a', kind: 'event_received', atMs: 21 }
  ], [{ client: 'x', opId: 'a' }, { client: 'x', opId: 'b' }])
  assert.equal(result.samples.filter(x => x.ok).length, 1)
  assert.ok(result.issues.some(x => x.reason === 'received_not_applied'))
  assert.ok(result.issues.some(x => x.reason === 'duplicate_receive'))
  assert.ok(result.issues.some(x => x.reason === 'missing_commit'))
})
test('disabled and broken observers cannot alter behavior', () => {
  assert.equal(observer.enabled(), false)
  observer.record('test')
  globalThis.__COLLAB_PERF_OBSERVER__ = () => { throw new Error('sink failure') }
  assert.doesNotThrow(() => observer.record('test'))
  delete globalThis.__COLLAB_PERF_OBSERVER__
})
test('matching opId cannot hide a wrong room or version', () => {
  const result = correlate(new Map([['a', { atMs: 10, roomKey: 'r', revision: 2 }]]), [
    { client: 'x', opId: 'a', kind: 'event_received', atMs: 20, roomKey: 'other', revision: 2 },
    { client: 'x', opId: 'a', kind: 'event_applied', atMs: 30, roomKey: 'r', revision: 3, disposition: 'remote' }
  ], [{ client: 'x', opId: 'a' }])
  assert.ok(result.samples.every(x => !x.ok))
  assert.equal(result.issues.filter(x => x.reason === 'room_or_revision_mismatch').length, 2)
})
test('shape counts only expanded traversal', () => {
  assert.deepEqual(observer.treeShape({ data: {}, children: [{ data: { expand: false }, children: [{ data: {} }] }] }),
    { visibleNodes: 2, maxDepth: 1, branches: 1, maxChildren: 1 })
})
test('observer enabled or throwing leaves adapter revision and callback results unchanged', async () => {
  const { createCollaborationAdapter } = require('../../bin/collabV2/adapter')
  const events = []
  const run = async sink => {
    let applications = 0
    if (sink) globalThis.__COLLAB_PERF_OBSERVER__ = sink
    else delete globalThis.__COLLAB_PERF_OBSERVER__
    const adapter = createCollaborationAdapter({ clientId: 'diag-local', onRemoteOperation: async () => { applications++; return true } })
    const op = { roomKey: 'diag-room', opId: '0a66b100-9133-4a6a-a8c1-a223619ad9a0', clientId: 'diag-remote', type: 'node.updated', serverRevision: 1, payload: { uid: 'n', text: 'synthetic' } }
    await adapter.applyRemoteOperation(op)
    await adapter.applyRemoteOperation(op)
    const result = { applications, revision: adapter.getStatus().lastServerRevision }
    await adapter.disconnect()
    return result
  }
  process.env.COLLAB_V2_TRACE = '0'
  const baseline = await run(null)
  assert.deepEqual(await run(event => events.push(event)), baseline)
  assert.deepEqual(await run(() => { throw new Error('sink failure') }), baseline)
  assert.equal(events.filter(x => x.kind === 'event_applied').length, 1)
  assert.equal(events.filter(x => x.kind === 'event_duplicate').length, 1)
  delete globalThis.__COLLAB_PERF_OBSERVER__
})
