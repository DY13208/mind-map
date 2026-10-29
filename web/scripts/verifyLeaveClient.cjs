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
    alias: { '@': path.join(root, 'src'), 'simple-mind-map': path.resolve(root, '../simple-mind-map') },
    plugins: [
      {
        name: 'leave-client',
        setup(build) {
          build.onLoad({ filter: /utils[\\/]roomLocation\.js$/ }, () => ({
            contents: 'export const roomFromLocation=route=>route.query.room||""',
            loader: 'js'
          }))
          build.onLoad({ filter: /\.vue$/ }, a => ({
            contents: compiler.parseComponent(fs.readFileSync(a.path, 'utf8'))
              .script.content,
            resolveDir: path.dirname(a.path),
            loader: 'js'
          }))
          build.onLoad({ filter: /services[\\/]leaveService\.js$/ }, () => ({
            contents:
              'export default global.__leaveClient;export const leaveOperationId=()=>"test-op";export const openLeaveRequest=detail=>window.dispatchEvent(new CustomEvent("mindmap:leave-open",{detail}))',
            loader: 'js'
          }))
          build.onLoad({ filter: /services[\\/]productHttp\.js$/ }, () => ({
            contents: 'export const productRequest=async()=>({attachments:[]})',
            loader: 'js'
          }))
          build.onLoad({ filter: /utils[\\/]agentChat\.js$/ }, () => ({
            contents:
              'export const checkAiBackend=async()=>({ok:false});export const streamChat=async()=>({content:""})',
            loader: 'js'
          }))
          build.onLoad({ filter: /utils[\\/]runtimeConfig\.js$/ }, () => ({
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
  vm.row = {...row('rule-confirmation'),template:{kind:'generic',fingerprint:'reviewed-policy'},report:{...row('rule-confirmation').report,publication:{valid:false}}}
  assert.equal(vm.canSubmit,false)
  vm.rulesChecked=true
  assert.equal(vm.canSubmit,true)
  await vm.submit()
  assert.equal(writes[0][2].confirmRules,true)
  assert.equal(writes[0][2].expectedPolicyFingerprint,'reviewed-policy')
  assert.equal(vm.rulesChecked,false,'reloading clears explicit rule confirmation')
  writes=[]
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
  trigger.requestTemplates = new Map()
  service.resolve = async () => ({
    candidates: [{ source: { roomKey: 'policy', nodeUid: 'template' } }]
  })
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
  trigger.$store.state.isReadonly = false
  trigger.requestByNode.clear()
  service.resolve = async () => ({
    candidates: [
      { title: '合同签约', source: { roomKey: 'contracts', nodeUid: 'one' } },
      { title: '其他签约', source: { roomKey: 'other', nodeUid: 'two' } }
    ]
  })
  trigger.onTextEnd(null, [], node('我要签合同'))
  await tick()
  assert.equal(trigger.choosing, true)
  assert.equal(
    prepared,
    1,
    'ambiguous matches must not prepare the first candidate'
  )
  await trigger.begin({ roomKey: 'other', nodeUid: 'two' })
  assert.equal(prepared, 2, 'an explicit choice prepares that workflow')
  trigger.requestByNode.clear()
  service.catalog = async () => ({ list: [], hasMore: false })
  service.resolve = async () => ({ candidates: [], reason: '未登记此审批' })
  trigger.onTextEnd(null, [], node('我要补卡'))
  await tick()
  assert.equal(prepared, 2)
  assert.equal(trigger.error, '未登记此审批')
  // Copied/imported maps can retain node UIDs. A cached application belongs
  // only to its original room, even when the editor component is reused.
  clearTimeout(trigger.checkTimer)
  trigger.requestByNode.clear()
  trigger.$route.query.room = 'personal'
  service.resolve = async () => ({
    candidates: [{ source: { roomKey: 'policy', nodeUid: 'template' } }]
  })
  trigger.onTextEnd(null, [], intent)
  await tick()
  assert.ok(trigger.requestId)
  clearTimeout(trigger.checkTimer)
  trigger.$route.query.room = 'copied-room'
  trigger.candidate = node('我要请假')
  trigger.update()
  assert.equal(
    trigger.requestId,
    '',
    'An identical UID in another room must not reuse the old application'
  )

  // An outstanding read must not import data after navigation or a switch to
  // read-only. These assertions exercise the boundary before the write.
  let finishRead,
    imports = 0
  service.get = () =>
    new Promise(resolve => {
      finishRead = resolve
    })
  service.act = async () => {
    imports++
    return row('pending')
  }
  for (const change of ['room', 'request', 'readonly', 'destroy']) {
    trigger.$route.query.room = 'personal'
    trigger.$store.state.isReadonly = false
    trigger.readonly = false
    trigger.requestId = 'pending'
    trigger.node = intent
    trigger.signatures.clear()
    trigger._isDestroyed = false
    const pending = trigger.checkNodes()
    if (change === 'room') trigger.$route.query.room = 'other'
    if (change === 'request') trigger.requestId = 'another'
    if (change === 'readonly') trigger.$store.state.isReadonly = true
    if (change === 'destroy') trigger._isDestroyed = true
    finishRead(row('pending'))
    await pending
    assert.equal(
      imports,
      0,
      'A stale ' + change + ' context must not import application data'
    )
    trigger.busy = false
    trigger._isDestroyed = false
    clearTimeout(trigger.checkTimer)
  }
  // Discovering a template is asynchronous too: do not create a draft if the
  // user has left the node or lost editing permission while matching it.
  let finishResolve
  const previousPrepared = prepared
  for (const change of ['room', 'node', 'readonly', 'destroy']) {
    trigger.$route.query.room = 'personal'
    trigger.$store.state.isReadonly = false
    trigger.requestByNode.clear()
    trigger.candidate = intent
    trigger.update()
    service.resolve = () =>
      new Promise(resolve => {
        finishResolve = resolve
      })
    const pending = trigger.begin()
    if (change === 'room') trigger.$route.query.room = 'other'
    if (change === 'node') trigger.node = null
    if (change === 'readonly') trigger.$store.state.isReadonly = true
    if (change === 'destroy') trigger._isDestroyed = true
    finishResolve({
      candidates: [{ source: { roomKey: 'policy', nodeUid: 'template' } }]
    })
    await pending
    assert.equal(
      prepared,
      previousPrepared,
      'A stale ' + change + ' match must not create a draft'
    )
    trigger.busy = false
    trigger._isDestroyed = false
    clearTimeout(trigger.checkTimer)
  }
  // Right-click validates the selected original node and never creates siblings.
  assert.equal(typeof trigger.startNodeApproval, 'function')
  trigger.$route.query.room = 'personal'
  trigger.$store.state.isReadonly = false
  trigger.busy = false
  trigger.requestByNode.clear()
  const notices = [], inserted = [], liveNodes = new Map()
  trigger.$message = { warning: text => notices.push(text), error: text => notices.push(text) }
  const liveNode = (uid, text) => {
    const data = {uid, text}
    return { parent: {getData:()=> 'parent'}, nodeData:{data,children:[]}, getData: key => key ? data[key] : data }
  }
  const sourceNode = liveNode('selected-flow', '转正申请表')
  liveNodes.set('selected-flow', sourceNode)
  trigger.mindMap.renderer = {findNodeByUid: uid => liveNodes.get(uid)}
  trigger.mindMap.execCommand = (command, openEdit, targets, data) => {
    if(command !== 'INSERT_NODE') return
    inserted.push({command,targets,data})
    const anchor = liveNode(data.uid, data.text)
    Object.assign(anchor.nodeData.data, data)
    liveNodes.set(data.uid, anchor)
  }
  const selectedSource = {roomKey:'personal',nodeUid:'selected-flow'}
  let requirementFields = [{key:'employee',label:'员工'}], templateReads = 0
  service.template = async source => {
    templateReads++
    assert.deepEqual(source, selectedSource)
    return {title:'转正申请表',fields:requirementFields,source:selectedSource}
  }
  const explicitPreparations = []
  let opened = 0
  trigger.open = async () => { opened++ }
  service.prepare = async (...args) => {
    explicitPreparations.push(args)
    return {...row('11111111-1111-4111-a111-111111111111'),report:{missing:['员工'],blockers:['请填写员工']}}
  }
  await trigger.startNodeApproval(sourceNode)
  clearTimeout(trigger.checkTimer)
  assert.equal(inserted.length, 0)
  assert.deepEqual(explicitPreparations[0], ['personal','selected-flow',selectedSource,true])
  assert.equal(opened,1,'original-node validation opens the material summary')
  assert.ok(notices.some(text => text.includes('员工') && text.includes('填写')))
  requirementFields = []
  trigger.requestByNode.clear()
  await trigger.startNodeApproval(sourceNode)
  assert.equal(inserted.length, 0, 'empty requirements cannot create branches')
  assert.ok(notices.some(text=>text.includes('提交要求')))
  trigger.$store.state.isReadonly = true
  const readsBefore = templateReads
  await trigger.startNodeApproval(sourceNode)
  assert.equal(templateReads, readsBefore, 'read-only cannot launch a workflow')
  trigger.$store.state.isReadonly = false
  requirementFields = [{key:'employee',label:'员工'}]
  let finishTemplate
  service.template = () => new Promise(resolve => {finishTemplate=resolve})
  const lateLaunch = trigger.startNodeApproval(sourceNode)
  trigger.$route.query.room = 'another-room'
  finishTemplate({title:'转正申请表',fields:requirementFields})
  await lateLaunch
  assert.equal(inserted.length, 0, 'navigation during template loading must not insert a node')
  let directlyOpened
  await Intent.methods.open.call({
    node:sourceNode,requestId:'',isPolicy:true,hasSubmissionRequirements:true,
    startNodeApproval:async node=>{directlyOpened=node}
  })
  assert.equal(directlyOpened,sourceNode,'the bottom action opens this original form instead of resolving an intent or opening policy settings')
  directlyOpened = null
  await Intent.methods.openCurrent.call({
    node:sourceNode,requestId:'old-withdrawn',hasSubmissionRequirements:true,
    publishDefinition:async node=>{directlyOpened=node},
    open:()=>{throw new Error('closed source-node requests must restart through the direct entry')}
  })
  assert.equal(directlyOpened,sourceNode)
  trigger.$route.query.room='personal'
  trigger.candidate=sourceNode
  trigger.requestByNode.set(JSON.stringify(['personal','selected-flow']),'old-withdrawn')
  service.get=async()=>({...row('old-withdrawn'),status:'withdrawn',template:{sourceNodeInput:true}})
  service.template=async()=>({title:'转正申请表',fields:requirementFields,source:selectedSource})
  const beforeRestart=explicitPreparations.length
  await trigger.startNodeApproval(sourceNode)
  clearTimeout(trigger.checkTimer)
  assert.equal(explicitPreparations.length,beforeRestart+1,'a cached withdrawn request must not force opening an unusable historical draft')
  assert.equal(inserted.length,0)
  let reflows=0, invalidations=0
  const markedTree={data:{uid:'published',text:'审批流程'},children:[{data:{uid:'value',text:'原内容'},children:[]}]}
  const publishedNode={getPureData:()=>markedTree,reRender:()=>true}
  const markContext={definitionMarks:new Map(),$route:{query:{room:'personal'}},mindMap:{renderer:{findNodeByUid:()=>publishedNode},render:()=>{reflows++}},refreshDefinitions:()=>{}}
  service.definitions=async()=>({list:[{nodeUid:'published',version:'1',state:'published'}],hasMore:false})
  service.invalidateDefinition=async()=>{invalidations++}
  await Intent.methods.refreshDefinitions.call(markContext)
  assert.equal(reflows,1,'a badge size change relayouts the entire map, not only the decorated node')
  markedTree.children[0].data.text='新内容'
  Intent.methods.checkDefinitionEdits.call(markContext)
  clearTimeout(markContext.definitionRefreshTimer)
  assert.equal(reflows,2,'the wider draft badge also recalculates surrounding nodes and connectors')
  assert.equal(invalidations,1)
  assert.equal(markedTree.data.tag,undefined,'approval markers never persist render-only tags into user content')
  vm.$destroy()
  trigger.$destroy()
  console.log(
    'Leave client checks passed: node-only submission, no automatic form, stale-submit isolation, late-response isolation, bounded pending-node retries, permission denial, explicit intent, deduplication, cancellation, room-scoped cache and stale-check/read-only safety'
  )
}
main().catch(e => {
  console.error(e.stack || e)
  process.exitCode = 1
})
