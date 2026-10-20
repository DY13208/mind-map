const assert = require('node:assert/strict')
const fs = require('node:fs'),
  path = require('node:path'),
  Module = require('node:module')
const compiler = require('vue-template-compiler'),
  esbuild = require('esbuild')
async function main() {
  const Vue = require('vue'),
    emitted = []
  global.window = {
    removeEventListener() {},
    addEventListener() {},
    location: { origin: 'http://local' },
    setTimeout: callback => setTimeout(callback, 0),
    dispatchEvent: e => emitted.push(e)
  }
  global.__leaveClient = {}
  const root = path.resolve(__dirname, '..')
  const result = await esbuild.build({
    stdin: {
      resolveDir: root,
      contents:
        "export {default as Dialog} from './src/components/LeaveRequestDialog.vue';export {default as Intent} from './src/pages/Edit/components/LeaveIntentTrigger.vue'"
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    alias: { '@': path.join(root, 'src') },
    plugins: [
      {
        name: 'leave-client',
        setup(build) {
          build.onLoad({ filter: /\.vue$/ }, a => ({
            contents: compiler.parseComponent(fs.readFileSync(a.path, 'utf8'))
              .script.content,
            resolveDir: path.dirname(a.path),
            loader: 'js'
          }))
          build.onLoad({ filter: /services\/leaveService\.js$/ }, () => ({
            contents:
              'export default global.__leaveClient;export const leaveOperationId=()=>"test-op";export const openLeaveRequest=detail=>window.dispatchEvent(new CustomEvent("mindmap:leave-open",{detail}))',
            loader: 'js'
          }))
          build.onLoad({ filter: /services\/productHttp\.js$/ }, () => ({
            contents: 'export const productRequest=async()=>({attachments:[]})',
            loader: 'js'
          }))
          build.onLoad({ filter: /utils\/agentChat\.js$/ }, () => ({
            contents:
              'export const checkAiBackend=async()=>({ok:false});export const streamChat=async()=>({content:""})',
            loader: 'js'
          }))
          build.onLoad({ filter: /utils\/runtimeConfig\.js$/ }, () => ({
            contents:
              'export const getRuntimeConfig=()=>({collabApi:"http://local"})',
            loader: 'js'
          }))
        }
      }
    ]
  })
  const mod = new Module(__filename, module)
  mod.paths = module.paths
  mod._compile(result.outputFiles[0].text, __filename)
  const { Dialog, Intent } = mod.exports,
    service = global.__leaveClient
  const row = id => ({
    id,
    requester_id: 'applicant',
    status: 'draft',
    revision: 1,
    fields: { attachmentIds: [] },
    report: {
      nodeInputHash: 'hash',
      blockers: [],
      publication: { valid: true }
    },
    template: {},
    history: []
  })
  const vm = new (Vue.extend(Dialog))({ propsData: { userId: 'applicant' } })
  let writes = [],
    lateResolve
  service.template = async () => ({})
  service.members = async () => ({ list: [] })
  service.get = async id => row(id)
  service.act = async (...args) => {
    writes.push(args)
  }
  // Closing and opening another request while save is in flight cannot submit the new one.
  vm.row = row('one')
  service.act = async (...args) => {
    writes.push(args)
    await new Promise(r => {
      lateResolve = r
    })
  }
  const submission = vm.submit()
  vm.close()
  vm.row = row('two')
  lateResolve()
  await submission
  assert.equal(writes.length, 1)
  assert.equal(writes[0][1], 'submit')
  assert.equal(writes[0][2].nodeSource, true)
  assert.equal(writes[0][2].expectedNodeHash, 'hash')
  service.act = async (...args) => {
    writes.push(args)
    return row(args[0])
  }
  // Late prepare responses cannot replace the newly opened application.
  let firstResolve
  service.prepare = async (room, uid) =>
    uid === 'one'
      ? new Promise(r => {
          firstResolve = r
        })
      : row(uid)
  const firstOpen = vm.open({ roomKey: 'personal', nodeUid: 'one' })
  await vm.open({ roomKey: 'personal', nodeUid: 'two' })
  firstResolve(row('one'))
  await firstOpen
  assert.equal(vm.row.id, 'two')
  // New nodes may not yet be committed by collaboration; bounded retry only for that error.
  let attempts = 0
  service.prepare = async () => {
    if (++attempts < 3)
      throw Object.assign(new Error('pending node'), {
        code: 'NODE_SCOPE_INVALID'
      })
    return row('new')
  }
  await vm.open({ roomKey: 'personal', nodeUid: 'new' })
  assert.equal(attempts, 3)
  assert.equal(vm.row.id, 'new')
  attempts = 0
  service.prepare = async () => {
    attempts++
    throw Object.assign(new Error('无权编辑'), { code: 'FORBIDDEN' })
  }
  await vm.open({ roomKey: 'personal', nodeUid: 'blocked' })
  assert.equal(attempts, 1)
  assert.equal(vm.error, '无权编辑')
  const trigger = new (Vue.extend(Intent))({
    propsData: { mindMap: { off() {} } }
  })
  trigger.$bus = new Vue()
  trigger.$store = { state: { isReadonly: false } }
  trigger.$route = { query: { room: 'personal' } }
  trigger.requestByNode = new Map()
  trigger.signatures = new Map()
  const node = text => ({
    nodeData: { data: { uid: 'anchor', text }, children: [] },
    getData: key =>
      key ? { uid: 'anchor', text }[key] : { uid: 'anchor', text }
  })
  let prepared = 0
  service.prepare = async () => {
    prepared++
    return row('11111111-1111-4111-a111-111111111111')
  }
  const tick = () => new Promise(r => setImmediate(r))
  let count = emitted.length
  const intent = node('我要请假')
  trigger.onTextEnd(null, [], intent)
  await tick()
  assert.equal(prepared, 1)
  assert.equal(
    emitted.slice(count).some(e => e.type === 'mindmap:leave-open'),
    false
  )
  trigger.onTextEnd(null, [], intent)
  await tick()
  assert.equal(prepared, 1)
  assert.equal(
    emitted.slice(count).some(e => e.type === 'mindmap:leave-open'),
    false
  )
  trigger.onTextEnd(null, [], node('我要取消请假'))
  await tick()
  assert.equal(prepared, 1)
  assert.equal(
    emitted.slice(count).some(e => e.type === 'mindmap:leave-open'),
    false
  )
  trigger.$store.state.isReadonly = true
  trigger.onTextEnd(null, [], node('申请年假'))
  await tick()
  assert.equal(prepared, 1)
  assert.equal(
    emitted.slice(count).some(e => e.type === 'mindmap:leave-open'),
    false
  )
  vm.$destroy()
  trigger.$destroy()
  console.log(
    'Leave client checks passed: node-only submission, no automatic form, stale-submit isolation, late-response isolation, bounded pending-node retries, permission denial, explicit intent, deduplication, cancellation and read-only safety'
  )
}
main().catch(e => {
  console.error(e.stack || e)
  process.exitCode = 1
})
