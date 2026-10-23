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
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (process.env[k] === undefined) process.env[k] = v
}

const origin = 'http://127.0.0.1:8990'
const rooms = [
  'c2-profile-1000-1788764665084',
  'c2-profile-1000-1788764369215',
  'c2-browser-5000-1788761408598',
  'c2-browser-10000-1788761472060',
  'p0-persist-50-empty-last-57d99954-7874-42c2-bf2d-f7a791cf84fa',
  'p0-persist-200-empty-last-8168dd5f-a714-4198-92e4-e697cf3760c2',
  'p0-persist-500-canonical-middle-e5f17402-b7f9-4c41-9580-f09266f85015'
]

;(async () => {
  const login = await fetch(origin + '/api/auth/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify({ key: process.env.AUTH_DEV_BYPASS_KEY })
  })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const out = []
  for (const room of rooms) {
    const paths = [
      `/api/files/${room}/info`,
      `/api/files/${room}?format=meta`,
      `/api/files/${room}/snapshot?format=meta`
    ]
    const row = { room }
    for (const p of paths) {
      const res = await fetch(origin + p, { headers: { cookie, Origin: origin } })
      const data = await res.json().catch(() => ({}))
      row[p] = {
        status: res.status,
        keys: Object.keys(data || {}),
        nodeCount: data.nodeCount || data.node_count || data.count || (data.meta && data.meta.nodeCount),
        revision: data.revision || data.rev || (data.file && data.file.revision),
        title: data.title || (data.file && data.file.title)
      }
    }
    out.push(row)
  }
  fs.writeFileSync(path.join(__dirname, 'room-meta.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
})().catch(e => {
  console.error(e)
  process.exit(1)
})
