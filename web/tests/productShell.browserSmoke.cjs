const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const { chromium } = require(
  path.resolve(__dirname, '../../simple-mind-map/node_modules/playwright')
)

const ORIGIN = 'http://127.0.0.1:8081'
const stamp = Date.now().toString(36)
const FOLDER = 'C3SmokeFolder-' + stamp
const ROOM = 'C3SmokeMap-' + stamp
const RENAMED = 'C3SmokeRenamed-' + stamp
const VERSION = 'C3SmokeVersion-' + stamp

function readDevKey() {
  const envPath = path.resolve(__dirname, '../../.env')
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find(row => row.startsWith('AUTH_DEV_BYPASS_KEY='))
  const key = line ? line.slice('AUTH_DEV_BYPASS_KEY='.length).trim() : ''
  if (!key) throw new Error('AUTH_DEV_BYPASS_KEY missing')
  return key
}

async function api(page, pathname, options = {}) {
  return page.evaluate(
    async ({ pathname, options }) => {
      const res = await fetch(pathname, {
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        method: options.method || 'GET',
        body: options.body || undefined
      })
      const text = await res.text()
      let data = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch (err) {
        data = { raw: text.slice(0, 200) }
      }
      return { ok: res.ok, status: res.status, data }
    },
    { pathname, options }
  )
}

async function confirmPrompt(page, value) {
  const box = page.locator('.el-message-box').last()
  await box.waitFor({ state: 'visible', timeout: 15000 })
  const input = box.locator('input')
  if ((await input.count()) && value) await input.fill(value)
  await box.locator('.el-button--primary').click()
}

async function main() {
  const key = readDevKey()
  const restorePosts = []
  const browser = await chromium.launch({ headless: true })
  const page = await (await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 }
  })).newPage()
  page.on('request', req => {
    if (req.method() === 'POST' && /\/versions\/[^/]+\/restore$/.test(req.url())) {
      restorePosts.push({ url: req.url(), postData: req.postData() })
    }
  })
  try {
    await page.goto(ORIGIN + '/#/files', { waitUntil: 'domcontentloaded' })
    await page.locator('.authDevInput').waitFor({ timeout: 20000 })
    await page.locator('.authDevInput').fill(key)
    await page.locator('.authDevForm button[type="submit"]').click()
    await page.waitForSelector('.productShell, .editContainer', { timeout: 20000 })
    await page.goto(ORIGIN + '/#/files', { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: '我的脑图' }).waitFor({ timeout: 20000 })

    const listed = await api(page, '/api/files?limit=5')
    assert.equal(listed.status, 200, JSON.stringify(listed.data))
    assert.ok(Array.isArray(listed.data.list))
    assert.ok(!JSON.stringify(listed.data.list).includes('"nodes"'))

    await page.getByRole('button', { name: '新建文件夹' }).click()
    await confirmPrompt(page, FOLDER)
    await page.locator('.folderCard', { hasText: FOLDER }).waitFor({ timeout: 20000 })
    const folders = await api(page, '/api/folders')
    const folder = (folders.data.list || []).find(item => item.name === FOLDER)
    assert.ok(folder && folder.id, JSON.stringify(folders.data))

    await page.getByRole('button', { name: '新建脑图' }).click()
    await confirmPrompt(page, ROOM)
    await page.waitForURL(/room=room-/, { timeout: 20000 })
    const roomKey = decodeURIComponent(
      new URL(page.url()).hash.match(/room=([^&]+)/)[1]
    )
    assert.ok(roomKey.startsWith('room-'), roomKey)
    await page.waitForSelector('#mindMapContainer', { timeout: 25000 })

    await page.goto(ORIGIN + '/#/files')
    await page.locator('.roomCard', { hasText: ROOM }).waitFor({ timeout: 20000 })

    const renamed = await api(page, '/api/files/' + encodeURIComponent(roomKey), {
      method: 'PATCH',
      body: JSON.stringify({ title: RENAMED })
    })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.roomCard', { hasText: RENAMED }).waitFor({ timeout: 20000 })

    const moved = await api(
      page,
      '/api/files/' + encodeURIComponent(roomKey) + '/move',
      { method: 'POST', body: JSON.stringify({ folderId: folder.id }) }
    )
    assert.equal(moved.status, 200, JSON.stringify(moved.data))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.folderCard', { hasText: FOLDER }).click()
    await page.locator('.roomCard', { hasText: RENAMED }).waitFor({ timeout: 20000 })

    const del = await api(page, '/api/folders/' + encodeURIComponent(folder.id), {
      method: 'DELETE'
    })
    assert.equal(del.status, 409)
    assert.equal(del.data.code, 'FOLDER_NOT_EMPTY')
    const still = await api(
      page,
      '/api/files/' + encodeURIComponent(roomKey) + '/info'
    )
    assert.equal(still.status, 200)

    const toRoot = await api(
      page,
      '/api/files/' + encodeURIComponent(roomKey) + '/move',
      { method: 'POST', body: JSON.stringify({ folderId: 'root' }) }
    )
    assert.equal(toRoot.status, 200)
    assert.equal(toRoot.data.file.folderId, null)

    const createdVer = await api(
      page,
      '/api/files/' + encodeURIComponent(roomKey) + '/versions',
      {
        method: 'POST',
        body: JSON.stringify({ name: VERSION, description: 'smoke' })
      }
    )
    assert.ok(createdVer.ok, JSON.stringify(createdVer.data))
    const versionId = createdVer.data.version.versionId
    const versions = await api(
      page,
      '/api/files/' + encodeURIComponent(roomKey) + '/versions'
    )
    assert.ok(
      (versions.data.versions || []).some(item => item.name === VERSION)
    )
    const restore = await api(
      page,
      '/api/files/' +
        encodeURIComponent(roomKey) +
        '/versions/' +
        encodeURIComponent(versionId) +
        '/restore',
      {
        method: 'POST',
        body: JSON.stringify({
          expectedCurrentRevision: versions.data.currentRevision
        })
      }
    )
    assert.ok(restore.ok, JSON.stringify(restore.data))
    assert.ok(restorePosts.length, 'restore went through browser fetch')
    const body = JSON.parse(restorePosts[0].postData || '{}')
    assert.ok(Object.prototype.hasOwnProperty.call(body, 'expectedCurrentRevision'))

    await page.goto(ORIGIN + '/#/files')
    await page.getByRole('heading', { name: '我的脑图' }).waitFor()
    await page.locator('.roomCard', { hasText: RENAMED }).click()
    await page.waitForURL(new RegExp('room=' + roomKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), {
      timeout: 20000
    })
    await page.waitForSelector('#mindMapContainer', { timeout: 25000 })

    console.log(
      JSON.stringify({
        ok: true,
        roomKey,
        folderId: folder.id,
        restoreCalls: restorePosts.length,
        expectedCurrentRevision: body.expectedCurrentRevision,
        newRevision: restore.data.newRevision
      })
    )
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
