// Run against a production frontend build with an isolated in-memory API.
// node test/folderDeletion.browser.test.js <absolute-build-directory>
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('@playwright/test')
const { createFileSystem, createMemoryFileStore, handleFileSystemApi } = require('../bin/fileSystem')

async function main() {
  const build = path.resolve(process.argv[2] || '')
  assert.ok(fs.existsSync(path.join(build, 'index.html')), 'provide a frontend production build directory')
  const previousAdmins = process.env.MIND_MAP_SUPER_ADMIN_IDS
  process.env.MIND_MAP_SUPER_ADMIN_IDS = 'fixture-super-admin'
  let engine, store, source, child, target, direct, actor = 'owner'
  async function seed(empty = false, asAdmin = false) {
    actor = asAdmin ? 'fixture-super-admin' : 'owner'
    store = createMemoryFileStore()
    if (asAdmin) {
      const listFolders = store.listFolders.bind(store)
      store.listFolders = async opts => (await listFolders(opts)).map(f => ({ ...f, can_manage: false }))
    }
    engine = createFileSystem({ store })
    source = await engine.createFolder({ name: '待删除文件夹', userId: 'owner' })
    target = await engine.createFolder({ name: '保留内容的目标', userId: 'owner' })
    if (!empty) {
      child = await engine.createFolder({ name: '下级文件夹', parentId: source.id, userId: 'owner' })
      direct = (await engine.createRoom({ title: '直接脑图', folderId: source.id, userId: 'owner' })).room.roomKey
      await engine.createRoom({ title: '下级脑图', folderId: child.id, userId: 'owner' })
    }
  }
  const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/dist\//, '/')
      if (pathname === '/api/auth/me') return json(res, { enabled: true, authenticated: true, user: { id: actor, name: '测试账号', corpId: 'test-corp' } })
      if (pathname === '/api/teams') return json(res, { items: [], list: [] })
      if (pathname.startsWith('/api/')) {
        req.authUser = { id: actor, corpId: 'test-corp' }
        if (await handleFileSystemApi(req, res, { engine })) return
        return json(res, { ok: true, list: [] })
      }
      if (pathname === '/runtime-config.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        return res.end('window.__MIND_MAP_RUNTIME__ = { gateway: true };')
      }
      const file = path.resolve(build, '.' + pathname)
      assert.ok(file.startsWith(build + path.sep) || file === build)
      const served = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(build, 'index.html')
      const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' }
      res.writeHead(200, { 'Content-Type': types[path.extname(served)] || 'application/octet-stream' })
      fs.createReadStream(served).pipe(res)
    } catch (error) { res.writeHead(500); res.end(error.message) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser, page
  const errors = []
  try {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
    page.setDefaultTimeout(10000)
    page.on('pageerror', e => errors.push(e.message))
    const open = async (empty = false, asAdmin = false) => {
      await seed(empty, asAdmin)
      await page.goto(origin + '/files')
      const card = page.locator('.folderCard').filter({ hasText: '待删除文件夹' })
      await card.waitFor()
      if (await page.locator('.el-popover:visible').count()) {
        await page.getByRole('button', { name: '消息中心', exact: true }).click()
      }
      await card.locator('.more').click()
      if (asAdmin) await page.locator('.el-dropdown-menu:visible').getByText('重命名', { exact: true }).waitFor()
      await page.locator('.el-dropdown-menu:visible').getByText('删除', { exact: true }).click()
      await page.locator('.deleteFolderDialog:visible .el-dialog').waitFor()
      await page.getByText('正在检查文件夹内容…').waitFor({ state: 'hidden' })
    }
    await open()
    const dialog = page.locator('.deleteFolderDialog:visible')
    await dialog.getByText(/2 个脑图/).waitFor()
    await dialog.locator('.el-select').click()
    const options = page.locator('.el-select-dropdown:visible')
    assert.equal(await options.getByText('待删除文件夹', { exact: true }).count(), 0)
    assert.equal(await options.getByText('下级文件夹', { exact: true }).count(), 0)
    await options.getByText('保留内容的目标', { exact: true }).click()
    await dialog.getByRole('button', { name: '移动内容并删除' }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal((await store.getRoom(direct)).folder_id, target.id)
    assert.equal((await store.getFolder(child.id)).parent_id, target.id)
    assert.equal(await store.getFolder(source.id), null)
    assert.equal(await page.locator('.folderCard').filter({ hasText: '待删除文件夹' }).count(), 0)

    await page.setViewportSize({ width: 390, height: 844 })
    await open()
    await dialog.locator('.el-radio').filter({ hasText: '全部删除' }).click()
    await dialog.getByText(/所有脑图将移入回收站/).waitFor()
    const rect = await dialog.locator('.el-dialog').boundingBox()
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 390, 'dialog fits narrow viewport')
    if (process.env.FOLDER_DELETION_SCREENSHOT) await page.screenshot({ path: process.env.FOLDER_DELETION_SCREENSHOT, fullPage: true })
    await dialog.getByRole('button', { name: '全部删除', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(store.folders.size, 1)
    assert.ok([...store.rooms.values()].every(r => r.deleted_at && r.folder_id === null))

    await open(true)
    await dialog.getByText('这是一个空文件夹，确认删除吗？').waitFor()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    assert.ok(await store.getFolder(source.id), 'cancel preserves the folder')
    await page.setViewportSize({ width: 1360, height: 900 })
    await open(false, true)
    await dialog.locator('.el-radio').filter({ hasText: '全部删除' }).click()
    await dialog.getByRole('button', { name: '全部删除', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await store.getFolder(source.id), null, 'super-admin can delete another owner\'s folder')
    assert.equal((await store.getRoom(direct)).deleted_by, 'fixture-super-admin')
    assert.deepEqual(errors, [])
    console.log('Production frontend browser checks passed: owner and super-admin menus, move, recursive trash, cancel, live list refresh, and 390px dialog')
  } catch (error) {
    if (page) {
      console.error('Fixture page:', page.url(), (await page.locator('body').innerText()).slice(0, 1800), errors)
    }
    throw error
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
    if (previousAdmins === undefined) delete process.env.MIND_MAP_SUPER_ADMIN_IDS
    else process.env.MIND_MAP_SUPER_ADMIN_IDS = previousAdmins
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
