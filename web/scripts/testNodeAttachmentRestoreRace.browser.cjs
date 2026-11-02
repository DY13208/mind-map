const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const babel = require('../node_modules/@babel/core')
const compiler = require('../node_modules/vue-template-compiler')

function loadChromium() {
  const candidates = [
    'playwright',
    path.join(
      'C:', 'Users', 'yiran', '.cache', 'codex-runtimes',
      'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'
    ),
    path.join(__dirname, '../../simple-mind-map/node_modules/@playwright/test')
  ]
  let lastError
  for (const candidate of candidates) {
    try {
      return require(candidate).chromium
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('Playwright Chromium is unavailable')
}

function loadComponentBundle() {
  const sourcePath = path.join(__dirname, '../src/pages/Edit/components/NodeAttachment.vue')
  const parsed = compiler.parseComponent(fs.readFileSync(sourcePath, 'utf8'))
  assert.ok(parsed.script, 'NodeAttachment SFC must contain a script')
  const code = babel.transformSync(parsed.script.content, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('../node_modules/@babel/plugin-transform-modules-commonjs')]
  }).code
  return `
    (function () {
      const module = { exports: {} }
      const require = name => {
        if (!Object.prototype.hasOwnProperty.call(window.__attachmentMocks, name)) {
          throw new Error('Unexpected NodeAttachment import: ' + name)
        }
        return window.__attachmentMocks[name]
      }
      new Function('require', 'module', 'exports', ${JSON.stringify(code)})(require, module, module.exports)
      window.NodeAttachment = module.exports.default
    })()
  `
}

async function main() {
  const chromium = loadChromium()
  const repo = path.resolve(__dirname, '../..')
  const componentBundle = loadComponentBundle()
  const vuePath = path.join(repo, 'web/node_modules/vue/dist/vue.min.js')
  assert.ok(fs.existsSync(vuePath), 'Vue browser runtime must be installed')
  const server = http.createServer((req, res) => {
    if (req.url === '/vue.js') {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(fs.readFileSync(vuePath))
      return
    }
    if (req.url === '/component.js') {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(componentBundle)
      return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><html><body>
      <script src="/vue.js"></script>
      <script>
        window.__messages = []
        window.__attachmentMocks = {
          '@/utils/roomLocation': { roomFromLocation: () => 'room-a' },
          '@/utils/attachmentProgressiveText': {
            attachmentUploadNotice: () => ({ type: 'info', message: '处理中' })
          },
          './KnowledgeFilePicker.vue': {},
          'simple-mind-map/src/utils/attachmentFileName': {
            normalizeAttachmentFileName: value => value
          },
          '@/utils/knowledgeFiles': {
            MAX_KNOWLEDGE_FILES: 10,
            readKnowledgeFileReference: async file => file
          },
          '@/utils/nodeAttachmentApi': {
            getNodeAttachment: async () => ({ attachment: null }),
            getRoomRevision: async () => 1,
            deleteNodeAttachment: async () => ({}),
            uploadNodeAttachment: () => window.__uploadPromise,
            waitForAttachmentReady: async () => ({}),
            maxAttachmentBytes: () => 1000000,
            formatAttachmentMaxMb: () => '1'
          }
        }
        Vue.prototype.$bus = { $on() {}, $off() {}, $emit() {} }
        Vue.prototype.$route = { params: { roomKey: 'room-a' } }
        Vue.prototype.$confirm = async () => true
        const message = value => {
          window.__messages.push({ type: (value && value.type) || 'message', message: value && value.message })
          return { close() {} }
        }
        ;['success', 'warning', 'error', 'info'].forEach(type => {
          message[type] = text => window.__messages.push({ type, message: text })
        })
        Vue.prototype.$message = message
      </script>
      <script src="/component.js"></script>
    </body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  let browser
  try {
    try {
      browser = await chromium.launch({ headless: true, channel: 'msedge' })
    } catch (error) {
      browser = await chromium.launch({ headless: true, channel: 'chrome' })
    }
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => window.NodeAttachment && window.Vue)

    const result = await page.evaluate(async () => {
      const makeNode = data => ({
        uid: data.uid,
        nodeData: { data: { ...data }, children: [] },
        children: [],
        getData(key) { return key == null ? this.nodeData.data : this.nodeData.data[key] }
      })
      const original = makeNode({
        uid: 'restore-aba', text: '目标', attachmentId: 'same-id',
        attachmentName: '旧附件.pdf', attachmentUrl: '/old',
        attachmentMimeType: 'application/pdf', attachmentStatus: 'ready'
      })
      const listeners = new Map()
      const map = {
        opt: { readonly: false },
        renderer: {
          root: original,
          activeNodeList: [],
          findNodeByUid(uid) {
            return map.renderer.root && map.renderer.root.getData('uid') === uid
              ? map.renderer.root
              : null
          },
          reRenderNodeCheckChange() {}
        },
        on(event, callback) {
          const callbacks = listeners.get(event) || new Set()
          callbacks.add(callback)
          listeners.set(event, callbacks)
        },
        off(event, callback) {
          const callbacks = listeners.get(event)
          if (callbacks) callbacks.delete(callback)
        },
        emit(event, ...args) {
          ;[...(listeners.get(event) || [])].forEach(callback => callback(...args))
        },
        writes: [],
        execCommand(command, target, url, name, meta) {
          this.writes.push(command)
          if (command === 'SET_NODE_ATTACHMENT') {
            Object.assign(target.nodeData.data, {
              attachmentUrl: url,
              attachmentName: name,
              ...(meta || {})
            })
          }
        }
      }
      const app = new Vue({
        render: h => h(window.NodeAttachment, { props: { mindMap: map } })
      }).$mount()
      document.body.appendChild(app.$el)
      await Vue.nextTick()
      const component = app.$children[0]
      window.__uploadPromise = new Promise(resolve => { window.__resolveUpload = resolve })
      const target = component.captureTarget(original, 'room-a')
      component.beginOperation(target)
      const pending = component.onFilePicked({
        target: { files: [{ name: '新附件.pdf', size: 8, type: 'application/pdf' }], value: '' }
      }, [target])
      map.emit('before_set_data')
      const restored = makeNode({ ...original.getData() })
      map.renderer.root = restored
      window.__resolveUpload({ attachment: {
        id: 'late-id', fileName: '新附件.pdf', mimeType: 'application/pdf',
        status: 'ready', extractedText: '迟到摘要'
      } })
      await pending
      const outcome = {
        writes: map.writes.length,
        attachmentId: restored.getData('attachmentId'),
        successMessages: window.__messages.filter(item => item.type === 'success').length,
        warnings: window.__messages.filter(item => item.type === 'warning').map(item => item.message)
      }
      app.$destroy()
      return outcome
    })

    assert.deepEqual(result, {
      writes: 0,
      attachmentId: 'same-id',
      successMessages: 0,
      warnings: ['目标版本已变化，附件已上传到服务器，未挂载到当前版本']
    })
    assert.deepEqual(pageErrors, [])
    console.log('PASS Chromium NodeAttachment restore race: mounted Vue component rejects delayed same-ID upload after before_set_data')
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
