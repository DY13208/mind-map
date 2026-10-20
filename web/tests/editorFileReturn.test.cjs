const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')

function setup({ file, error, context = null } = {}) {
  const calls = { read: [], navigate: [] }
  const filename = path.resolve(__dirname, '../src/utils/editorFileReturn.js')
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    babelrc: false, configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const module = { exports: {} }
  const dependencies = {
    '@/services/roomService': { getRoomInfo: async room => {
      calls.read.push(room)
      if (error) throw error
      return file
    } },
    './fileNavigation': {
      normalizeReturnTo: value => typeof value === 'string' && /^\/(files|my-maps)(\/|$)/.test(value) ? value : '',
      readReturnContext: () => context,
      navigateToFileList: async (router, data) => calls.navigate.push(data)
    }
  }
  new Function('require', 'module', 'exports', code)(name => dependencies[name], module, module.exports)
  return { ...module.exports, calls }
}

test('复制链接即使没有 session 记录也优先原目录，不额外请求脑图', async () => {
  const subject = setup({ error: new Error('offline') })
  const route = { path: '/', fullPath: '/?room=a', query: { room: 'a', returnTo: '/files/folder/source', shell: 'embed' } }
  assert.equal(await subject.returnFromEditor({ currentRoute: route }, route), true)
  assert.deepEqual(subject.calls.read, [])
  assert.equal(subject.calls.navigate[0].route.query.shell, 'embed')
})

test('直接打开时复用当前详情，旧脑图详情不能用作新脑图归属', async () => {
  const next = { roomKey: 'new', folderId: 'new-folder' }
  const subject = setup({ file: next })
  const route = { fullPath: '/?room=new', query: { room: 'new' } }
  await subject.returnFromEditor({ currentRoute: route }, route, { roomKey: 'old', folderId: 'old-folder' })
  assert.deepEqual(subject.calls.read, ['new'])
  assert.equal(subject.calls.navigate[0].file, next)
  subject.calls.read.length = 0
  await subject.returnFromEditor({ currentRoute: route }, route, next)
  assert.deepEqual(subject.calls.read, [])
})

test('网络超时、服务故障和登录失效保留当前编辑页，点击可重试', async () => {
  for (const error of [Object.assign(new Error('timeout'), { code: 'TIMEOUT' }), Object.assign(new Error('server'), { statusCode: 500 }), Object.assign(new Error('login'), { statusCode: 401 })]) {
    const subject = setup({ error })
    const route = { fullPath: '/?room=a', query: { room: 'a' } }
    await assert.rejects(subject.returnFromEditor({ currentRoute: route }, route), error)
    assert.deepEqual(subject.calls.navigate, [])
    await assert.rejects(subject.returnFromEditor({ currentRoute: route }, route), error)
    assert.equal(subject.calls.read.length, 2)
  }
})

test('脑图详情已不可访问时允许列表兜底，不能将该规则扩大到临时故障', async () => {
  for (const statusCode of [403, 404]) {
    const subject = setup({ error: Object.assign(new Error('unavailable'), { statusCode }) })
    const route = { fullPath: '/?room=a', query: { room: 'a' } }
    assert.equal(await subject.returnFromEditor({ currentRoute: route }, route), true)
    assert.equal(subject.calls.navigate[0].file, null)
  }
})

test('等待详情期间切换页面或脑图不会发生过期跳转', async () => {
  const subject = setup({ file: { roomKey: 'a', folderId: 'folder' } })
  const route = { fullPath: '/?room=a', query: { room: 'a' } }
  assert.equal(await subject.returnFromEditor({ currentRoute: { fullPath: '/?room=b' } }, route), false)
  assert.deepEqual(subject.calls.navigate, [])
})

test('现有团队归属字段从服务端 DTO 到编辑器详情保持完整，个人脑图兼容 null', () => {
  const { publicFile } = require('../../simple-mind-map/bin/fileSystem/model')
  const filename = path.resolve(__dirname, '../src/services/roomDto.js')
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    babelrc: false, configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(require, module, module.exports)
  const dto = publicFile({ room_key: 'team-room', folder_id: 'folder', team_id: 'team' })
  assert.equal(module.exports.normalizeRoomDto(dto).teamId, 'team')
  assert.equal(module.exports.normalizeRoomDto(dto).folderId, 'folder')
  const personal = publicFile({ room_key: 'personal-room' })
  assert.equal(module.exports.normalizeRoomDto(personal).teamId, null)
})
