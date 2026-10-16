const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const driverPath = path.resolve(__dirname, 'mcp-collab-performance.cjs')
const source = fs.readFileSync(driverPath, 'utf8')
const start = source.indexOf('async function installHttpRefreshAttribution(')
const end = source.indexOf('async function setupBrowserContexts(', start)
assert(start >= 0 && end > start, 'attribution functions are not in the expected isolated driver section')
const context = vm.createContext({ module: { exports: {} } })
vm.runInContext(`${source.slice(start, end)}\nmodule.exports = { installHttpRefreshAttribution, collectHttpRefreshAttribution }`, context,
  { filename: driverPath, timeout: 1000 })
const { installHttpRefreshAttribution, collectHttpRefreshAttribution } = context.module.exports

function makePage(window) {
  return {
    async evaluate(fn, arg) {
      const browserContext = vm.createContext({ window })
      const browserFunction = vm.runInContext(`(${fn.toString()})`, browserContext, { timeout: 1000 })
      return await browserFunction(arg)
    }
  }
}

async function run() {
  const calls = []
  const syncResult = { result: 'sync-object' }
  const thrown = new Error('PRIVATE_EXCEPTION_TEXT')
  const resolved = Promise.resolve('resolved-value')
  const cooperate = {
    lastAppliedVersion: 21,
    collabV2Adapter: { getStatus: () => ({ lastServerRevision: 22 }) },
    refreshVisibleFromHttp(input) {
      calls.push({ method: 'refreshVisibleFromHttp', thisPreserved: this === cooperate })
      return input && input.throw ? (() => { throw thrown })() : syncResult
    },
    recoverHttpCollab(input) {
      calls.push({ method: 'recoverHttpCollab', thisPreserved: this === cooperate })
      if (input && input.throw) throw thrown
      return input.promise
    },
    scheduleRemoteRecover(input) {
      calls.push({ method: 'scheduleRemoteRecover', thisPreserved: this === cooperate })
      return input.promise
    }
  }
  const page = { label: 'browser-test', page: makePage({ __perfRepairMindMap: { cooperate } }) }
  const install = await installHttpRefreshAttribution([page])
  assert.equal(install.status, 'installed')
  assert.equal(install.coveredPages, 1)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(install.pages[0].installedMethods)).sort(), [
    'recoverHttpCollab', 'refreshVisibleFromHttp', 'scheduleRemoteRecover'
  ])

  const sensitive = {
    targetVersion: 11,
    force: true,
    uid: 'PRIVATE_UID_SHOULD_NOT_APPEAR',
    text: 'PRIVATE_NODE_TEXT_SHOULD_NOT_APPEAR',
    token: 'PRIVATE_TOKEN_SHOULD_NOT_APPEAR'
  }
  const syncReturn = cooperate.refreshVisibleFromHttp(sensitive)
  assert.strictEqual(syncReturn, syncResult, 'synchronous return identity changed')
  const resolvedReturn = cooperate.recoverHttpCollab({ ...sensitive, targetVersion: 12, promise: resolved })
  assert.strictEqual(resolvedReturn, resolved, 'fulfilled promise identity changed')
  await resolvedReturn
  const rejected = Promise.reject(new Error('PRIVATE_REJECTION_TEXT'))
  const rejectedReturn = cooperate.scheduleRemoteRecover({ ...sensitive, targetVersion: 13, promise: rejected })
  assert.strictEqual(rejectedReturn, rejected, 'rejected promise identity changed')
  await assert.rejects(rejectedReturn, error => error.message === 'PRIVATE_REJECTION_TEXT')
  assert.throws(() => cooperate.recoverHttpCollab({ ...sensitive, throw: true }), error => error === thrown,
    'synchronous exception identity changed')
  assert(calls.every(row => row.thisPreserved), 'wrapper did not preserve the receiver')

  const initial = await collectHttpRefreshAttribution([page])
  assert.equal(initial.totals.calls, 4)
  assert.equal(initial.totals.completed, 4)
  assert.equal(initial.rows.length, 4)
  const refreshRow = initial.rows.find(row => row.method === 'refreshVisibleFromHttp')
  assert(refreshRow, 'missing sync refresh attribution')
  assert.equal(refreshRow.targetVersion, 11)
  assert.equal(refreshRow.force, true)
  assert.equal(refreshRow.lastAppliedVersion, 21)
  assert.equal(refreshRow.adapterLastServerRevision, 22)
  assert.equal(refreshRow.outcome, 'returned')
  assert(refreshRow.callerFunctions.length > 0, 'caller function names were not captured')
  assert(refreshRow.callerFunctions.every(name => !/[\\/:?#]/.test(name) && !/\.wrapped$/i.test(name)),
    'caller attribution retained a source path or wrapper frame')
  assert(Number.isFinite(refreshRow.startedAt) && Number.isFinite(refreshRow.endedAt) && Number.isFinite(refreshRow.durationMs),
    'start/end/duration fields are missing')
  const serializedInitial = JSON.stringify(initial)
  for (const secret of ['PRIVATE_UID_SHOULD_NOT_APPEAR', 'PRIVATE_NODE_TEXT_SHOULD_NOT_APPEAR',
    'PRIVATE_TOKEN_SHOULD_NOT_APPEAR', 'PRIVATE_EXCEPTION_TEXT', 'PRIVATE_REJECTION_TEXT']) {
    assert(!serializedInitial.includes(secret), `sensitive argument/error leaked into attribution: ${secret}`)
  }

  for (let index = 0; index < 405; index += 1) {
    cooperate.refreshVisibleFromHttp({ targetVersion: 100 + index, uid: `uid-${index}`, text: `body-${index}`, token: `token-${index}` })
  }
  const bounded = await collectHttpRefreshAttribution([page])
  assert.equal(bounded.rowsLimit, 400)
  assert.equal(bounded.capturedRows, 400)
  assert.equal(bounded.rows.length, 400)
  assert.equal(bounded.totals.calls, 409)
  assert.equal(bounded.ringOverwritten, 9)
  assert.equal(bounded.overwritten, 9)
  assert.equal(bounded.totals.byMethod.refreshVisibleFromHttp, 406)
  assert.equal(bounded.totals.byOutcome.returned, 406)
  assert(!JSON.stringify(bounded).includes('body-404'), 'sensitive arguments leaked from retained rows')

  const secondCooperate = {
    lastAppliedVersion: 30,
    collabV2Adapter: { getStatus: () => ({ lastServerRevision: 31 }) },
    refreshVisibleFromHttp() { return null },
    recoverHttpCollab() { return null },
    scheduleRemoteRecover() { return null }
  }
  const secondPage = { label: 'browser-test-2', page: makePage({ __perfRepairMindMap: { cooperate: secondCooperate } }) }
  const twoPageInstall = await installHttpRefreshAttribution([page, secondPage])
  assert.equal(twoPageInstall.coveredPages, 2, 'coverage count did not include both instrumented pages')
  for (let index = 0; index < 100; index += 1) cooperate.refreshVisibleFromHttp({ targetVersion: 1000 + index })
  for (let index = 0; index < 300; index += 1) secondCooperate.refreshVisibleFromHttp({ targetVersion: 2000 + index })
  const aggregateBounded = await collectHttpRefreshAttribution([page, secondPage])
  assert.equal(aggregateBounded.pageCount, 2)
  assert.equal(aggregateBounded.installedPages, 2)
  assert.equal(aggregateBounded.totals.calls, 809)
  assert.equal(aggregateBounded.rows.length, 400, 'aggregate rows exceeded the global 400-row bound')
  assert.equal(aggregateBounded.globalRetentionDroppedRows, 300)
  assert.equal(aggregateBounded.ringOverwritten, 109)
  assert.equal(aggregateBounded.overwritten, 409)

  console.log('PASS: HTTP refresh attribution preserves receiver, sync/promise return identity, rejections and throws; captures safe watermarks/versions; enforces a 400-row bound with overwrite totals.')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
