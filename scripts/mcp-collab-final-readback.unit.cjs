const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, 'mcp-collab-performance.cjs'), 'utf8').replace(/\r\n/g, '\n')
const startMarker = '    let result\n    try {\n      const resultHandle = await writer.page.waitForFunction'
const endMarker = '    const modelTextMatches = result.textAfterInput === text'
const start = source.indexOf(startMarker)
const end = source.indexOf(endMarker, start)
assert(start >= 0 && end > start, 'runBrowserWrite atomic final readback block should be present')
const readbackBlock = source.slice(start, end)

function createFixture(options = {}) {
  const uid = 'node-target'
  const defaultRenderTree = {
    data: { uid: 'root' },
    children: [{ data: { uid }, children: [] }]
  }
  const renderTree = options.renderTree === undefined ? defaultRenderTree : options.renderTree
  const targetNode = { getData: key => key === 'uid' ? uid : 'final-text' }
  const root = options.root === undefined ? {
    getData: key => key === 'uid' ? 'root' : undefined,
    nodeData: options.rootNodeData === undefined ? renderTree : options.rootNodeData,
    children: options.rootChildren === undefined ? [targetNode] : options.rootChildren
  } : options.root
  const index = options.index === undefined ? new Map([[uid, targetNode]]) : options.index
  const renderer = {
    renderTree,
    root,
    nodeIndex: index,
    isRendering: !!options.isRendering,
    renderTimer: options.renderTimer || null,
    hasWaitRendering: !!options.hasWaitRendering,
    _layoutEpoch: Object.prototype.hasOwnProperty.call(options, 'layoutEpoch') ? options.layoutEpoch : 11,
    findNodeByUid: value => index && typeof index.get === 'function' ? index.get(String(value)) : undefined
  }
  const adapter = {
    getStatus: () => Object.prototype.hasOwnProperty.call(options, 'adapterStatus')
      ? options.adapterStatus
      : ({ lastServerRevision: 42, serverRevision: 44 })
  }
  const mm = {
    renderer,
    cooperate: {
      _v2RemoteApplyEpoch: Object.prototype.hasOwnProperty.call(options, 'remoteApplyEpoch')
        ? options.remoteApplyEpoch
        : 8,
      collabV2Adapter: adapter
    }
  }
  const samples = []
  const context = vm.createContext({
    window: {
      __perfRepairMindMap: mm,
      __cpReadNodePlainText: node => node.getData('text')
    },
    append: (file, row) => samples.push({ file, row })
  })
  const readback = vm.runInContext(
    `(async function(writer, uid, phase, token, samplesPath, text = 'final-text') {\n${readbackBlock}\nreturn result\n})`,
    context
  )
  let fixture
  let waitCalls = 0
  let evaluateCalls = 0
  const writer = {
    identity: { userId: 'user-1' },
    page: {
      waitForFunction: async (callback, args, waitOptions) => {
        assert.equal(waitOptions.timeout, 15000)
        assert.equal(waitOptions.polling, 'raf')
        const attempts = options.pollLimit || 1
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          waitCalls += 1
          const value = callback(args)
          if (value) {
            if (options.afterTruthy) options.afterTruthy(fixture)
            return {
              jsonValue: async () => JSON.parse(JSON.stringify(value)),
              dispose: async () => {}
            }
          }
          if (options.onPoll) options.onPoll(attempt, fixture)
        }
        const error = new Error('page.waitForFunction timed out')
        error.name = 'TimeoutError'
        throw error
      },
      evaluate: async (callback, args) => {
        evaluateCalls += 1
        return callback(args)
      }
    }
  }
  fixture = { uid, renderTree, targetNode, root, renderer, mm, readback, writer, samples,
    get waitCalls() { return waitCalls }, get evaluateCalls() { return evaluateCalls } }
  return fixture
}

function json(value) {
  return JSON.parse(JSON.stringify(value))
}

async function expectMissing(fixture, phase, token, samplesPath, expected) {
  await assert.rejects(
    fixture.readback(fixture.writer, fixture.uid, phase, token, samplesPath),
    error => {
      assert.equal(error.code, 'RENDER_NODE_MISSING')
      assert.equal(error.message, 'RENDER_NODE_MISSING')
      assert.deepEqual(json(error.snapshot), expected)
      assert(!error.message.includes('final-text'))
      assert.equal(fixture.samples.length, 1)
      assert.equal(fixture.samples[0].file, 'samples.jsonl')
      assert.equal(fixture.samples[0].row.category, 'browser-render-node-probe')
      assert.equal(fixture.samples[0].row.phase, 'unit')
      assert.equal(fixture.samples[0].row.token, 'token')
      assert.equal(fixture.samples[0].row.uid, 'node-target')
      assert.equal(fixture.samples[0].row.userId, 'user-1')
      assert.deepEqual(json(fixture.samples[0].row.snapshot), expected)
      assert(!JSON.stringify(fixture.samples[0].row).includes('final-text'))
      assert.equal(fixture.evaluateCalls, 1, 'failure diagnostics should run once after bounded readback fails')
      return true
    }
  )
}

async function run() {
  const missingIndex = createFixture({ index: new Map() })
  await expectMissing(missingIndex, 'unit', 'token', 'samples.jsonl', {
    renderTreeUidPresent: true,
    renderTreeScanTruncated: false,
    rootModelUidPresent: true,
    rootModelScanTruncated: false,
    nodeIndexHasUid: false,
    nodeIndexSize: 0,
    rootNodeDataMatchesRenderTree: true,
    rendererIsRendering: false,
    hasRenderTimer: false,
    hasWaitRendering: false,
    rendererLayoutEpoch: 11,
    v2RemoteApplyEpoch: 8,
    adapterLastServerRevision: 42,
    adapterServerRevision: 44,
    safeRootUid: 'root'
  })

  const missingModel = createFixture({ index: new Map(), rootChildren: [] })
  await expectMissing(missingModel, 'unit', 'token', 'samples.jsonl', {
    renderTreeUidPresent: true,
    renderTreeScanTruncated: false,
    rootModelUidPresent: false,
    rootModelScanTruncated: false,
    nodeIndexHasUid: false,
    nodeIndexSize: 0,
    rootNodeDataMatchesRenderTree: true,
    rendererIsRendering: false,
    hasRenderTimer: false,
    hasWaitRendering: false,
    rendererLayoutEpoch: 11,
    v2RemoteApplyEpoch: 8,
    adapterLastServerRevision: 42,
    adapterServerRevision: 44,
    safeRootUid: 'root'
  })

  const invalidModel = createFixture({ renderTree: null, root: null, index: new Map() })
  await expectMissing(invalidModel, 'unit', 'token', 'samples.jsonl', {
    renderTreeUidPresent: null,
    renderTreeScanTruncated: false,
    rootModelUidPresent: null,
    rootModelScanTruncated: false,
    nodeIndexHasUid: false,
    nodeIndexSize: 0,
    rootNodeDataMatchesRenderTree: null,
    rendererIsRendering: false,
    hasRenderTimer: false,
    hasWaitRendering: false,
    rendererLayoutEpoch: 11,
    v2RemoteApplyEpoch: 8,
    adapterLastServerRevision: 42,
    adapterServerRevision: 44,
    safeRootUid: null
  })

  const unknownNumericFields = createFixture({
    index: { has: () => false, size: null },
    rootChildren: [],
    layoutEpoch: undefined,
    remoteApplyEpoch: '9',
    adapterStatus: { lastServerRevision: '42', serverRevision: undefined }
  })
  await expectMissing(unknownNumericFields, 'unit', 'token', 'samples.jsonl', {
    renderTreeUidPresent: true,
    renderTreeScanTruncated: false,
    rootModelUidPresent: false,
    rootModelScanTruncated: false,
    nodeIndexHasUid: false,
    nodeIndexSize: null,
    rootNodeDataMatchesRenderTree: true,
    rendererIsRendering: false,
    hasRenderTimer: false,
    hasWaitRendering: false,
    rendererLayoutEpoch: null,
    v2RemoteApplyEpoch: null,
    adapterLastServerRevision: null,
    adapterServerRevision: null,
    safeRootUid: 'root'
  })

  const transitioning = createFixture({
    index: new Map(),
    rootChildren: [],
    isRendering: true,
    pollLimit: 2,
    onPoll: attempt => {
      if (attempt === 0) {
        transitioning.renderer.isRendering = false
        transitioning.renderer.nodeIndex.set(transitioning.uid, transitioning.targetNode)
      }
    }
  })
  const transitionResult = json(await transitioning.readback(transitioning.writer, transitioning.uid, 'unit', 'token', 'samples.jsonl'))
  assert.deepEqual(transitionResult, {
    textAfterInput: 'final-text', rawTextAfterInput: 'final-text', revision: 42
  }, 'the bounded wait should retry through a render transition')
  assert.equal(transitioning.waitCalls, 2)
  assert.equal(transitioning.evaluateCalls, 0)
  assert.equal(transitioning.samples.length, 0)

  const atomic = createFixture({
    afterTruthy: fixture => {
      fixture.renderer.isRendering = true
      fixture.renderer.root = null
    }
  })
  const atomicResult = json(await atomic.readback(atomic.writer, atomic.uid, 'unit', 'token', 'samples.jsonl'))
  assert.deepEqual(atomicResult, {
    textAfterInput: 'final-text', rawTextAfterInput: 'final-text', revision: 42
  }, 'a render that begins immediately after the synchronous predicate cannot invalidate captured text/revision')
  assert.equal(atomic.evaluateCalls, 0, 'success must not perform a second model lookup')

  const normal = createFixture()
  const normalResult = json(await normal.readback(normal.writer, normal.uid, 'unit', 'token', 'samples.jsonl'))
  assert.deepEqual(normalResult, {
    textAfterInput: 'final-text',
    rawTextAfterInput: 'final-text',
    revision: 42
  }, 'successful readback retains the existing result shape')
  assert.equal(normal.evaluateCalls, 0, 'normal success is captured by one atomic browser predicate')
  console.log('PASS: actual runBrowserWrite final readback waits and captures UID/text/revision atomically; bounded failure diagnostics remain explicit and privacy-safe.')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
