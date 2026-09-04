const assert = require('assert').strict
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { chromium } = require(
  path.resolve(__dirname, '../../simple-mind-map/node_modules/playwright')
)

const ORIGIN = 'http://127.0.0.1:8081'

function readEnv(name) {
  const line = fs
    .readFileSync(path.resolve(__dirname, '../../.env'), 'utf8')
    .split(/\r?\n/)
    .find(row => row.startsWith(name + '='))
  return line ? line.slice(name.length + 1).trim() : ''
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

async function jsonFetch(cookie, pathname, options = {}) {
  const res = await fetch(ORIGIN + pathname, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Cookie: 'mind_map_session=' + cookie
    },
    body: options.body
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, data }
}

async function loginDev(page) {
  await page.goto(ORIGIN + '/#/files', { waitUntil: 'domcontentloaded' })
  await page.locator('.authDevInput').waitFor({ timeout: 20000 })
  await page.locator('.authDevInput').fill(readEnv('AUTH_DEV_BYPASS_KEY'))
  await page.locator('.authDevForm button[type="submit"]').click()
  await page.waitForSelector('.productShell, .editContainer', { timeout: 20000 })
  const cookies = await page.context().cookies()
  const session = cookies.find(item => item.name === 'mind_map_session')
  assert.ok(session && session.value, 'dev session cookie')
  return session.value
}

async function ensureForeignSession(userId) {
  const { Client } = require(path.resolve(
    __dirname,
    '../../simple-mind-map/node_modules/pg'
  ))
  const client = new Client({
    host: readEnv('PGHOST') || '127.0.0.1',
    port: Number(readEnv('PGPORT') || 5432),
    user: readEnv('PGUSER') || 'postgres',
    password: readEnv('PGPASSWORD') || '',
    database: readEnv('PGDATABASE') || 'mind_map'
  })
  await client.connect()
  const token = crypto.randomBytes(32).toString('base64url')
  try {
    await client.query(
      `insert into wecom_users (user_id, name, avatar, departments, last_login_at)
       values ($1, $2, '', '[]'::jsonb, now())
       on conflict (user_id) do update set last_login_at = now()`,
      [userId, userId]
    )
    await client.query(
      `insert into auth_sessions
         (token_hash, user_id, expires_at, absolute_expires_at)
       values (
         $1, $2,
         now() + interval '1 hour',
         now() + interval '1 day'
       )`,
      [sha256(token), userId]
    )
  } finally {
    await client.end()
  }
  return token
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage()
  try {
    const ownerCookie = await loginDev(page)
    const created = await jsonFetch(ownerCookie, '/api/files', {
      method: 'POST',
      body: JSON.stringify({ title: 'C3ShareGate-' + Date.now().toString(36) })
    })
    assert.ok(created.ok, JSON.stringify(created.data))
    const roomKey = created.data.room.roomKey || created.data.file.roomKey
    const listed = await jsonFetch(
      ownerCookie,
      '/api/files/' + encodeURIComponent(roomKey) + '/members'
    )
    assert.equal(listed.status, 200, JSON.stringify(listed.data))
    assert.ok(Array.isArray(listed.data.list))

    const editorId = 'c3-share-editor-' + Date.now().toString(36)
    const added = await jsonFetch(
      ownerCookie,
      '/api/files/' + encodeURIComponent(roomKey) + '/members',
      {
        method: 'POST',
        body: JSON.stringify({ userId: editorId, role: 'editor' })
      }
    )
    assert.equal(added.status, 200, JSON.stringify(added.data))
    assert.equal(String(added.data.role).toLowerCase(), 'editor')

    const patched = await jsonFetch(
      ownerCookie,
      '/api/files/' +
        encodeURIComponent(roomKey) +
        '/members/' +
        encodeURIComponent(editorId),
      { method: 'PATCH', body: JSON.stringify({ role: 'viewer' }) }
    )
    assert.equal(patched.status, 200, JSON.stringify(patched.data))
    assert.equal(String(patched.data.role).toLowerCase(), 'viewer')

    const restored = await jsonFetch(
      ownerCookie,
      '/api/files/' +
        encodeURIComponent(roomKey) +
        '/members/' +
        encodeURIComponent(editorId),
      { method: 'PATCH', body: JSON.stringify({ role: 'editor' }) }
    )
    assert.equal(restored.status, 200)

    const editorCookie = await ensureForeignSession(editorId)
    const editorManage = await jsonFetch(
      editorCookie,
      '/api/files/' + encodeURIComponent(roomKey) + '/members',
      {
        method: 'POST',
        body: JSON.stringify({ userId: 'c3-should-fail', role: 'viewer' })
      }
    )
    assert.equal(editorManage.status, 403)
    assert.equal(editorManage.data.code, 'FORBIDDEN')

    const viewerId = 'c3-share-viewer-' + Date.now().toString(36)
    const viewerAdded = await jsonFetch(
      ownerCookie,
      '/api/files/' + encodeURIComponent(roomKey) + '/members',
      {
        method: 'POST',
        body: JSON.stringify({ userId: viewerId, role: 'viewer' })
      }
    )
    assert.equal(viewerAdded.status, 200)
    const viewerCookie = await ensureForeignSession(viewerId)
    const viewerManage = await jsonFetch(
      viewerCookie,
      '/api/files/' +
        encodeURIComponent(roomKey) +
        '/members/' +
        encodeURIComponent(editorId),
      { method: 'PATCH', body: JSON.stringify({ role: 'viewer' }) }
    )
    assert.equal(viewerManage.status, 403)
    assert.equal(viewerManage.data.code, 'FORBIDDEN')

    const removed = await jsonFetch(
      ownerCookie,
      '/api/files/' +
        encodeURIComponent(roomKey) +
        '/members/' +
        encodeURIComponent(editorId),
      { method: 'DELETE' }
    )
    assert.equal(removed.status, 200, JSON.stringify(removed.data))

    console.log(
      JSON.stringify({
        ok: true,
        roomKey,
        ownerMembers: listed.data.list.length,
        editorForbidden: editorManage.status,
        viewerForbidden: viewerManage.status
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
