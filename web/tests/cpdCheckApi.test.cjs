const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')

const requests = []
const dependencies = {
  './fetchWithTimeout': {
    FetchTimeoutError: class FetchTimeoutError extends Error {},
    fetchWithTimeout: async (url, options) => {
      requests.push({ url, options })
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ok: true })
      }
    }
  },
  './runtimeConfig': { getRuntimeConfig: () => ({ collabApi: 'http://collab.test' }) },
  'simple-mind-map/src/utils/operationId': { createOperationId: () => 'operation-1' },
  'simple-mind-map/src/utils/collabTrace': { collabTrace() {}, collabPersistSnapshot() {} },
  '@/utils/importTree': { stringifyJsonOffMainThread: async payload => JSON.stringify(payload) }
}

function loadFileApi() {
  const filename = path.resolve(__dirname, '../src/utils/fileApi.js')
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const moduleRef = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    request => {
      if (!dependencies[request]) throw new Error(`Unmocked dependency: ${request}`)
      return dependencies[request]
    },
    moduleRef,
    moduleRef.exports
  )
  return moduleRef.exports
}

async function main() {
  const api = loadFileApi()
  const signal = new AbortController().signal
  await api.createCpdCheckRun('room/one', { nodeUid: 'node-1', requestId: 'request-1', signal })
  await api.listCpdCheckRuns('room/one', 'node-1', { signal })
  await api.getCpdCheckRun('room/one', 'run/1', { signal })
  await api.confirmCpdCheckCandidate('room/one', 'run/1', 'candidate/1', { signal })

  assert.equal(requests[0].url, 'http://collab.test/api/files/room%2Fone/cpd-checks')
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    nodeUid: 'node-1',
    requestId: 'request-1'
  })
  assert.equal(requests[0].options.signal, signal)
  assert.equal(
    requests[1].url,
    'http://collab.test/api/files/room%2Fone/cpd-checks?nodeUid=node-1'
  )
  assert.equal(requests[2].url, 'http://collab.test/api/files/room%2Fone/cpd-checks/run%2F1')
  assert.equal(
    requests[3].url,
    'http://collab.test/api/files/room%2Fone/cpd-checks/run%2F1/confirm'
  )
  assert.deepEqual(JSON.parse(requests[3].options.body), { candidateId: 'candidate/1' })
  assert.equal(requests[3].options.method, 'POST')

  await api.submitCpdCheckReview('room/one', 'run/1', { expectedRevision: 2, findingKey: 'finding-1', decision: 'reject', reason: '目标不一致', evidenceIds: ['e1'], requestId: 'review-1' }, { signal })
  await api.getCpdCheckSource('room/one', 'run/1', 'source/1', { signal })
  await api.retryCpdCheckSource('room/one', 'run/1', 'source/1', { expectedRevision: 3, requestId: 'retry-1' }, { signal })
  await api.createCpdCheckRun('room/one', { nodeUid: 'node-1', requestId: 'demo-1', mode: 'demo' })
  assert.match(requests[4].url, /run%2F1\/reviews$/)
  assert.equal(JSON.parse(requests[4].options.body).expectedRevision, 2)
  assert.match(requests[5].url, /sources\/source%2F1$/)
  assert.match(requests[6].url, /sources\/source%2F1\/retry$/)
  assert.equal(requests[6].options.method, 'POST')
  assert.equal(JSON.parse(requests[7].options.body).mode, 'demo')

  console.log('CPD check API endpoint tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
