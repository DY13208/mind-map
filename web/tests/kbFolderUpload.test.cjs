const test = require('node:test')
const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

function load(source, requireMap) {
  const { code } = babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const mod = { exports: {} }
  const req = name => (requireMap && name in requireMap ? requireMap[name] : require(name))
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports)
  return mod.exports
}

const kbDir = path.resolve(__dirname, '../src/features/knowledge-base')
const fu = load(fs.readFileSync(path.join(kbDir, 'utils/folderUpload.js'), 'utf8'))
const uq = load(fs.readFileSync(path.join(kbDir, 'utils/uploadQueue.js'), 'utf8'))
const status = load(fs.readFileSync(path.join(kbDir, 'constants/status.js'), 'utf8'))
const adapter = load(fs.readFileSync(path.join(kbDir, 'services/kbAclAdapter.js'), 'utf8'), { '../constants/status': status })

const file = (name, size = 10, rel) => ({ name, size, lastModified: 1, webkitRelativePath: rel || '' })

test('hidden and system files are ignored', () => {
  for (const p of ['A/.DS_Store', 'A/Thumbs.db', 'A/sub/desktop.ini', 'A/.git/config', '__MACOSX/A/x.pdf', 'A/~$报表.xlsx', 'A/.hidden.pdf']) {
    assert.equal(fu.isIgnoredPath(p), true, p)
  }
  for (const p of ['A/报表.xlsx', 'A/b/c.pdf', 'x.pdf']) assert.equal(fu.isIgnoredPath(p), false, p)
})

test('plan keeps structure, orders parents first, reports skipped files', () => {
  const precheck = f => uq.precheckFile(f, { maxFileBytes: 100, allowed: ['pdf', 'xlsx'] })
  const entries = fu.entriesFromInput([
    file('a.pdf', 10, '根/a.pdf'),
    file('b.xlsx', 10, '根/子/孙/b.xlsx'),
    file('big.pdf', 1000, '根/子/big.pdf'),
    file('x.exe', 10, '根/x.exe'),
    file('.DS_Store', 10, '根/子/.DS_Store'),
    file('only.exe', 10, '根/无效/only.exe')
  ])
  const plan = fu.planFolderUpload(entries, { emptyDirs: ['根/空目录', '根/.git'], precheck })
  assert.deepEqual(plan.dirs, ['根', '根/子', '根/空目录', '根/子/孙'])
  assert.deepEqual(plan.files.map(f => [f.path, f.dir]), [['根/a.pdf', '根'], ['根/子/孙/b.xlsx', '根/子/孙']])
  assert.deepEqual(plan.ignored, ['根/子/.DS_Store'])
  assert.deepEqual(plan.invalid.map(i => i.path), ['根/子/big.pdf', '根/x.exe', '根/无效/only.exe'])
  assert.ok(!plan.dirs.includes('根/无效'), 'a folder holding only skipped files is not created')
  const deep = fu.planFolderUpload([{ file: file('d.pdf'), path: Array(40).fill('d').join('/') + '/d.pdf' }], { maxDepth: 32 })
  assert.equal(deep.files.length, 0)
  assert.match(deep.invalid[0].message, /32/)
})

test('ensureFolders creates each path once, parent before child, bounded concurrency', async () => {
  const calls = []
  let active = 0
  let peak = 0
  const created = new Map()
  const create = async ({ name, parentId }) => {
    active++
    peak = Math.max(peak, active)
    calls.push([name, parentId || ''])
    await new Promise(r => setTimeout(r, 5))
    active--
    const id = 'id:' + (parentId || 'BASE') + '/' + name
    const reused = created.has(id)
    created.set(id, true)
    return { id, reused: name === '已有' || reused }
  }
  const dirs = ['根', '已有', '根/a', '根/b', '根/c', '根/d', '根/a/x']
  const steps = []
  const r = await fu.ensureFolders(dirs, { baseId: 'BASE', create, concurrency: 2, onStep: p => steps.push(p) })
  assert.equal(calls.length, dirs.length)
  assert.equal(new Set(calls.map(c => c.join('|'))).size, dirs.length)
  assert.ok(peak <= 2)
  assert.deepEqual(calls.slice(0, 2).map(c => c[1]), ['BASE', 'BASE'])
  assert.deepEqual(calls.find(c => c[0] === 'x'), ['x', 'id:id:BASE/根/a'])
  assert.equal(r.ids.get('根/a/x'), 'id:id:id:BASE/根/a/x')
  assert.equal(r.created, 6)
  assert.equal(r.reused, 1)
  assert.equal(steps.length, dirs.length)
})

test('ensureFolders retries unknown results and propagates failures to children', async () => {
  const seen = {}
  const sleeps = []
  const create = async ({ name, parentId }) => {
    seen[name] = (seen[name] || 0) + 1
    if (name === 'flaky' && seen[name] === 1) throw Object.assign(new Error('超时'), { kind: 'timeout' })
    if (name === 'denied') throw Object.assign(new Error('目标文件夹不存在或无权限'), { kind: 'not_found', status: 404 })
    return { id: (parentId || 'root') + '/' + name }
  }
  const r = await fu.ensureFolders(['flaky', 'denied', 'denied/child'], { create, sleep: ms => { sleeps.push(ms); return Promise.resolve() } })
  assert.equal(seen.flaky, 2)
  assert.equal(seen.denied, 1)
  assert.equal(seen.child, undefined)
  assert.equal(sleeps.length, 1)
  assert.equal(r.ids.get('flaky'), 'root/flaky')
  assert.equal(r.failed.get('denied/child'), '上级文件夹没有创建成功')
  const { ready, blocked } = fu.assignFolders(
    [{ path: 'flaky/a.pdf', dir: 'flaky' }, { path: 'denied/child/b.pdf', dir: 'denied/child' }, { path: 'top.pdf', dir: '' }], r.ids, r.failed)
  assert.deepEqual(ready.map(f => [f.path, f.folderId]), [['flaky/a.pdf', 'root/flaky'], ['top.pdf', '']])
  assert.match(blocked[0].message, /denied\/child/)
  const cancelled = await fu.ensureFolders(['a', 'a/b'], { create, isCancelled: () => true })
  assert.equal(cancelled.failed.get('a'), '已取消')
})

test('walkEntries reads every readEntries page, keeps empty dirs and skips hidden', async () => {
  const fileEntry = p => ({ isFile: true, isDirectory: false, fullPath: p, name: p.split('/').pop(), file: ok => ok(file(p.split('/').pop())) })
  const dir = (p, children, pageSize = 2) => ({
    isFile: false, isDirectory: true, fullPath: p, name: p.split('/').pop(),
    createReader() { let i = 0; return { readEntries(ok) { const page = children.slice(i, i + pageSize); i += pageSize; setTimeout(() => ok(page), 0) } } }
  })
  const root = dir('/根', [fileEntry('/根/1.pdf'), fileEntry('/根/2.pdf'), fileEntry('/根/3.pdf'), dir('/根/空', []), dir('/根/.git', [fileEntry('/根/.git/x')]), fileEntry('/根/Thumbs.db')])
  const r = await fu.walkEntries([root, fileEntry('/散.pdf')])
  assert.deepEqual(r.entries.map(e => e.path).sort(), ['散.pdf', '根/1.pdf', '根/2.pdf', '根/3.pdf'].sort())
  assert.deepEqual(r.emptyDirs, ['根/空'])
  assert.deepEqual(r.ignored.sort(), ['根/.git/', '根/Thumbs.db'].sort())
  const capped = await fu.walkEntries([root], { maxEntries: 2 })
  assert.equal(capped.truncated, true)
})

test('upload queue shows the relative path and keys files per target folder', () => {
  const items = []
  const q = uq.createUploadQueue({ items, concurrency: 1, run: () => new Promise(() => {}) })
  const f1 = file('a.pdf')
  const f2 = file('a.pdf')
  q.add([f1], { folderId: 'F1', nameOf: () => '根/x/a.pdf' })
  q.add([f2], { folderId: 'F2' })
  assert.deepEqual(items.map(i => [i.name, i.folderId]), [['根/x/a.pdf', 'F1'], ['a.pdf', 'F2']])
  q.dispose()
})

test('ACL adapter shows ancestor folder owners as read-only managers', () => {
  const members = adapter.membersFromAcl({
    grants: [
      { subjectType: 'user', subjectId: 'up', role: 'owner', source: 'owner', applied: true },
      { subjectType: 'user', subjectId: 'fo', role: 'viewer', source: 'direct', applied: false },
      { subjectType: 'user', subjectId: 'fo', role: 'manager', source: 'inherited', via: 'folder_owner', applied: true, inheritedFrom: { id: 'r', name: '部门资料' } }
    ]
  })
  const fo = members.find(m => m.id === 'fo')
  assert.equal(fo.role, 'manager')
  assert.equal(fo.inheritedOnly, true)
  assert.match(fo.sourceLabel, /部门资料.*所有者.*不生效/)
})

test('upload panel and tree wire folder upload', () => {
  const panel = fs.readFileSync(path.join(kbDir, 'components/KbUploadPanel.vue'), 'utf8')
  assert.match(panel, /webkitdirectory/)
  assert.match(panel, /@change="onPickFolder"/)
  assert.match(panel, /reuse: true/)
  assert.match(panel, /hasDirectoryEntry\(dt\)/)
  const tab = fs.readFileSync(path.join(kbDir, 'pages/KbFilesTab.vue'), 'utf8')
  assert.match(tab, /@folders-changed=/)
})
