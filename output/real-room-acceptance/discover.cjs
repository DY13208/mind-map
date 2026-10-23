'use strict'
const fs = require('fs')
const path = require('path')

const envPath = path.join(__dirname, '../../.env')
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const i = t.indexOf('=')
  if (i < 1) continue
  const k = t.slice(0, i).trim()
  let v = t.slice(i + 1).trim()
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1)
  }
  if (process.env[k] === undefined) process.env[k] = v
}

const key = process.env.AUTH_DEV_BYPASS_KEY
if (!key) {
  console.log(JSON.stringify({ ok: false, reason: 'no AUTH_DEV_BYPASS_KEY' }))
  process.exit(1)
}

;(async () => {
  const origin = 'http://127.0.0.1:8990'
  const login = await fetch(origin + '/api/auth/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify({ key })
  })
  const loginBody = await login.json()
  const setCookie = login.headers.get('set-cookie') || ''
  const cookie = setCookie.split(';')[0]
  const me = await fetch(origin + '/api/auth/me', {
    headers: { cookie, Origin: origin }
  })
  const meBody = await me.json()
  const files = await fetch(origin + '/api/files?limit=100&offset=0', {
    headers: { cookie, Origin: origin }
  })
  const filesBody = await files.json()
  const list = filesBody.list || filesBody.files || []
  const rooms = list.map(r => ({
    roomKey: r.roomKey || r.room_key || r.id,
    title: r.title || r.name || '',
    folderId: r.folderId || r.folder_id || null,
    updatedAt: r.updatedAt || r.updated_at || null,
    role: r.role || null
  }))
  const testish = rooms.filter(r =>
    /测试|test|e2e|perf|p1|p2|c2|lazy|验收|灰度/i.test(
      (r.title || '') + ' ' + (r.roomKey || '')
    )
  )
  const out = {
    ok: true,
    loginStatus: login.status,
    authenticated: !!(loginBody.authenticated || meBody.authenticated),
    userId:
      (meBody.user && meBody.user.id) ||
      (loginBody.user && loginBody.user.id) ||
      null,
    userName:
      (meBody.user && meBody.user.name) ||
      (loginBody.user && loginBody.user.name) ||
      null,
    roomCount: rooms.length,
    total: filesBody.total || null,
    testish,
    sampleTitles: rooms
      .slice(0, 30)
      .map(r => (r.title || '') + ' | ' + (r.roomKey || '')),
    filesStatus: files.status,
    filesError: filesBody.error || filesBody.code || null
  }
  fs.writeFileSync(
    path.join(__dirname, 'discovery.json'),
    JSON.stringify(out, null, 2)
  )
  console.log(JSON.stringify(out, null, 2))
})().catch(e => {
  console.error('ERR', e.message)
  process.exit(1)
})
