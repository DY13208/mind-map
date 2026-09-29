const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')
const vueCompiler = require('vue-template-compiler')

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
  './runtimeConfig': {
    getRuntimeConfig: () => ({ collabApi: 'http://collab.test' })
  },
  'simple-mind-map/src/utils/operationId': {
    createOperationId: () => 'generated-operation-id'
  },
  'simple-mind-map/src/utils/collabTrace': {
    collabTrace() {},
    collabPersistSnapshot() {}
  },
  '@/utils/importTree': {
    stringifyJsonOffMainThread: async payload => JSON.stringify(payload)
  }
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
      if (!dependencies[request]) {
        throw new Error(`Unmocked dependency: ${request}`)
      }
      return dependencies[request]
    },
    moduleRef,
    moduleRef.exports
  )
  return moduleRef.exports
}

function manyNodeTree(count) {
  return {
    data: { uid: 'root', text: 'root' },
    children: Array.from({ length: count - 1 }, (_, index) => ({
      data: { uid: `node-${index}`, text: `node ${index}` },
      children: []
    }))
  }
}

function loadImportComponent() {
  const filename = path.resolve(__dirname, '../src/pages/Edit/components/Import.vue')
  const parsed = vueCompiler.parseComponent(fs.readFileSync(filename, 'utf8'))
  const { code } = babel.transformSync(parsed.script.content, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const moduleRef = { exports: {} }
  const mocks = {
    'simple-mind-map/src/parse/xmind.js': {},
    'simple-mind-map/src/parse/markdown.js': {},
    vuex: { mapMutations: () => ({}) },
    '@/utils/importTree': {
      parseJsonOffMainThread: async () => ({ root: { data: { uid: 'root' }, children: [] } }),
      yieldToUi: async () => {}
    },
    '@/utils/loading': { hideLoading() {} }
  }
  new Function('require', 'module', 'exports', 'console', code)(
    request => {
      if (!mocks[request]) throw new Error(`Unmocked dependency: ${request}`)
      return mocks[request]
    },
    moduleRef,
    moduleRef.exports,
    { log() {} }
  )
  return moduleRef.exports.default
}

async function main() {
  const { replaceFileTree } = loadFileApi()

  await replaceFileTree('room-restored', manyNodeTree(2), {
    baseVersion: 11,
    operationId: 'small-import-op'
  })
  const smallRequest = requests[0]
  assert.equal(smallRequest.url, 'http://collab.test/api/files/room-restored/replace')
  assert.equal(JSON.parse(smallRequest.options.body).baseVersion, 11)

  await replaceFileTree('room-restored', manyNodeTree(400), {
    baseVersion: 12,
    operationId: 'large-import-op'
  })
  const largeRequest = requests[1]
  assert.equal(JSON.parse(largeRequest.options.body).baseVersion, 12)
  assert.equal(JSON.parse(largeRequest.options.body).tree.children.length, 399)

  const importComponent = loadImportComponent()
  const originalFileReader = global.FileReader
  let finishFileRead
  const fileReadFinished = new Promise(resolve => {
    finishFileRead = resolve
  })
  global.FileReader = class {
    readAsText() {
      Promise.resolve()
        .then(() => this.onload({ target: { result: '{"root":{}}' } }))
        .then(finishFileRead)
    }
  }
  const messages = []
  const listeners = Object.create(null)
  let failurePayload = null
  const context = {
    $bus: {
      $once(event, fn) {
        listeners[event] = fn
      },
      $off(event, fn) {
        if (!fn || listeners[event] === fn) delete listeners[event]
      },
      $emit(event) {
        if (event !== 'setData') return
        const fail = listeners.setDataFailed
        if (fail) {
          delete listeners.setDataFailed
          failurePayload = {
            code: 'STALE_AFTER_VERSION_RESTORE',
            message: 'pending operation is stale after VERSION_RESTORE',
            notified: true
          }
          fail(failurePayload)
        }
      }
    },
    $message: {
      error: message => messages.push(message),
      success: message => messages.push(message)
    },
    $t: key => key
  }
  Object.assign(context, importComponent.methods)
  try {
    context.handleSmm({ raw: {} })
    await fileReadFinished
    assert.equal(failurePayload.code, 'STALE_AFTER_VERSION_RESTORE')
    assert.equal(failurePayload.notified, true)
    assert.deepEqual(messages, [], 'Import.vue must not repeat a server error toast already shown by Edit.vue')
    assert.equal(listeners.setDataFailed, undefined, 'the one-shot error listener should be cleaned up')
  } finally {
    if (originalFileReader === undefined) delete global.FileReader
    else global.FileReader = originalFileReader
  }

  console.log('replaceFileTree version and import error notification tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
