const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const babel = require('@babel/core'), compiler = require('vue-template-compiler')
function load(source, deps) {
  const mod = { exports: {} }
  const code = babel.transformSync(source, { babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] }).code
  new Function('require', 'module', 'exports', code)(name => deps[name] || {}, mod, mod.exports)
  return mod.exports
}
async function run() {
  const pages = []
  const service = load(fs.readFileSync(path.join(__dirname, '../src/services/mentionUsers.js'), 'utf8'), {
    './productHttp': { productRequest: async url => { pages.push(url); const n = Number(new URL(url, 'http://localhost').searchParams.get('offset')); return { list: Array.from({ length: n ? 23 : 50 }, (_, i) => ({ id: 'u' + (n + i), name: '同事' + (n + i) })), nextCursor: n ? null : '50' } } }
  })
  const first = await service.searchMentionUsers('', 0)
  const next = await service.searchMentionUsers('', first.nextOffset)
  assert.equal(first.list.length + next.list.length, 73)
  assert.equal(next.list[22].userId, 'u72')
  assert.equal(next.nextOffset, null)
  assert.ok(pages[1].includes('offset=50'))
  const component = load(compiler.parseComponent(fs.readFileSync(path.join(__dirname, '../src/pages/Edit/components/NodeTextMention.vue'), 'utf8')).script.content, {
    '@/utils/commentUser': { currentCommentUser: () => ({ userId: 'sender', userName: '发送者' }) }
  })
  const methods = component.default.methods
  const inserted = [], typingFormats = []
  const root = { focus() {} }
  const quill = {
    getSelection: () => ({ index: 3 }), getText: () => '@同事',
    getFormat: () => ({ size: '18px', italic: true }), deleteText() {},
    insertText: (...args) => inserted.push(args), setSelection() {},
    format: (...args) => typingFormats.push(args)
  }
  methods.pick.call({ editor: () => ({ root, quill }), mentionRange: {}, mentionEditor: { root }, query: '同事', close() {},
    pending: [{ userId: 'u1' }] }, { userId: 'u1', name: '同事' })
  assert.equal(inserted[0][1], '@同事')
  assert.deepEqual(inserted[0][2], { size: '18px', italic: true, color: '#087d56', background: false, bold: true })
  assert.equal(inserted[1][1], ' ')
  assert.equal(inserted[1][2].color, false)
  assert.equal(inserted[1][2].background, false)
  assert.equal(inserted[1][2].bold, false)
  assert.ok(typingFormats.some(([key, value]) => key === 'color' && value === false), 'following text must keep normal formatting')
  const sessions = load(fs.readFileSync(path.join(__dirname, '../../simple-mind-map/src/utils/collabEditSession.js'), 'utf8'), {}).createEditSessionManager()
  const edit = sessions.begin({ uid: 'n', fields: ['text', 'textMentions'], snapshot: { data: { text: '原文', textMentions: [], __fv: { text: 3, textMentions: 5 } } } })
  assert.equal(edit.baseVersions.textMentions, 5)
  assert.equal(sessions.buildExpected(edit.id, ['text', 'textMentions'])['__fv.textMentions'], 5)
  const revision = sessions.get(edit.id).draftRevision
  assert.equal(sessions.updateDraft(edit.id, { text: '原文' }).draftRevision, revision)
  assert.equal(sessions.updateDraft(edit.id, { text: '新正文' }).draftRevision, revision + 1)
  assert.equal(sessions.updateDraft(edit.id, { text: '新正文' }).draftRevision, revision + 1)
  const merged = component.default.computed.candidates.call({ query: '', people: first.list, roomMembers: [{ userId: 'u72', name: '房间成员' }, first.list[0]] })
  assert.equal(merged.length, 51)
  assert.ok(merged.some(m => m.userId === 'u72'))
  const coopSource = fs.readFileSync(path.join(__dirname, '../../simple-mind-map/src/plugins/Cooperate.js'), 'utf8')
  const coopAst = babel.parseSync(coopSource, { babelrc: false, configFile: false, sourceType: 'module' })
  let commitMethod
  babel.traverse(coopAst, { ClassMethod(p) { if (p.node.key.name === 'commitEditSession') commitMethod = p.node } })
  const commit = new Function(`return async function(id,patch){${coopSource.slice(commitMethod.body.start + 1, commitMethod.body.end - 1)}}`)()
  const saveSession = sessions.begin({ uid: 'n2', roomKey: 'r', fields: ['text', 'textMentions'], initialDraft: { text: '正文 @同事 ', textMentions: [] }, snapshot: { data: { text: '原文', textMentions: [], __fv: { text: 1, textMentions: 1 } } } })
  const saveVm = { editSessionManager: sessions, collabV2Adapter: {}, httpCollabMode: true, httpRoomKey: 'r', _pendingEditSessionByFingerprint: new Map(), validateEditSession: () => ({ ok: true }), editSessionOperationFingerprint: () => 'test', resolveEditSession: id => sessions.resolve(id),
    submitV2: async () => { sessions.updateDraft(saveSession.id, { text: '正文 @同事 ' }); return { version: 2 } } }
  assert.equal((await commit.call(saveVm, saveSession.id, { text: '正文 @同事 ', textMentions: [] })).draftSaved, true, 'duplicate input reads during ACK must not retain the editor as an unsaved draft')
  const comment = load(compiler.parseComponent(fs.readFileSync(path.join(__dirname, '../src/pages/Edit/components/NodeCommentCard.vue'), 'utf8')).script.content, {})
  assert.equal(comment.default.computed.mentionCandidates.call({ mentionQuery: '', mentionPool: first.list }).length, 50)
  assert.equal(comment.default.computed.mentionCandidates.call({ mentionQuery: 'u49', mentionPool: first.list })[0].userId, 'u49')
  const originalDocument = global.document
  global.document = { createElement: () => ({ set innerHTML(value) { this.textContent = value.replace(/<[^>]*>/g, '') } }) }
  try {
    const data = { text: '<p>任务 @同事 完成</p>', textMentions: [] }
    const node = { getData: key => data[key] }
    const writes = []
    const picked = { userId: 'u1', name: '同事', id: 'm1', time: 123, authorId: 'sender' }
    const vm = { close() {}, editNode: node, editRoom: 'room-a', $route: { query: { room: 'room-a' } }, pending: [picked], mindMap: { execCommand: (...args) => writes.push(args) } }
    methods.finish.call(vm, null, [], node, { editSessionDiscarded: true })
    assert.equal(writes.length, 0)
    vm.editNode = node
    const patch = { text: data.text }
    methods.prepare.call(vm, node, patch)
    assert.deepEqual(patch.textMentions, [picked])
    assert.equal(writes.length, 0, 'metadata must be committed with text, never as a second command')
    vm.editNode = node; vm.editRoom = 'other-room'
    const ignored = { text: data.text }
    methods.prepare.call(vm, node, ignored)
    assert.equal(ignored.textMentions, undefined)
    vm.editRoom = 'room-a'; data.text = '任务已移除提及'; data.textMentions = [picked]
    const removed = { text: data.text }
    methods.prepare.call(vm, node, removed)
    assert.deepEqual(removed.textMentions, [])
  } finally { global.document = originalDocument }
  // Run the real editor hide methods, capturing their protected commit payload.
  for (const [file, name, rich] of [
    ['../../simple-mind-map/src/plugins/RichText.js', 'hideEditText', true],
    ['../../simple-mind-map/src/core/render/TextEdit.js', 'hideEditTextBox', false]
  ]) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
    const ast = babel.parseSync(source, { babelrc: false, configFile: false, sourceType: 'module' })
    let method
    babel.traverse(ast, { ClassMethod(p) { if (p.node.key.name === name) method = p.node } })
    const body = source.slice(method.body.start + 1, method.body.end - 1)
    const hide = new Function('trimNodeEditText', `return function(nodes){${body}}`)(text => text)
    let submitted
    const node = {}
    const vm = { showTextEdit: true, node, currentNode: node, editSessionId: 's', getEditText: () => '正文 @同事 ', syncEditSessionDraft() {}, setIsShowTextEdit() {}, textEditNode: { style: {} }, renderer: { activeNodeList: [node] },
      mindMap: { opt: {}, renderer: { activeNodeList: [node] }, emit(event, _node, patch) { if (event === 'before_node_text_edit_commit') patch.textMentions = [{ userId: 'u1', name: '同事' }] }, cooperate: {
        getEditSession: () => ({ baseVersions: { text: 1 } }), commitEditSession: async (_id, patch) => { submitted = patch; return { draftSaved: true } }
      } }
    }
    await hide.call(vm)
    assert.equal(submitted.text, '正文 @同事 ')
    assert.equal(submitted.textMentions[0].userId, 'u1')
    if (rich) assert.equal(submitted.richText, true)
  }
  const route = load(fs.readFileSync(path.join(__dirname, '../src/utils/mentionFormat.js'), 'utf8'), {})
  assert.deepEqual(route.mentionRoute({ room_key: 'r', node_uid: 'n', source: 'node_text', comment_id: 'node-text:n:m' }).query, { room: 'r', focus: 'n' })
  console.log('Node text mentions: directory pagination, save-only reminders, discard/room guard, removal and deep links passed')
}
run().catch(e => { console.error(e); process.exitCode = 1 })
