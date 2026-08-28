require('./loadEnv')
const { Pool } = require('pg')
const COS = require('cos-nodejs-sdk-v5')
const Y = require('yjs')
const { setPersistence, getYDoc, docs } = require('y-websocket/bin/utils')

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD
})

const cos = new COS({
  SecretId: process.env.TENCENT_COS_SECRET_ID,
  SecretKey: process.env.TENCENT_COS_SECRET_KEY
})

const Bucket = process.env.TENCENT_COS_BUCKET
const Region = process.env.TENCENT_COS_REGION
const location = String(process.env.TENCENT_COS_LOCATION || 'mind-map').replace(
  /^\/+|\/+$/g,
  ''
)
const acl = process.env.TENCENT_COS_ACL || 'private'

const saveTimers = new Map()
const preloadCache = new Map()

function safeRoomKey(roomKey) {
  return String(roomKey || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80)
}

function cosKey(roomKey) {
  return `${location}/${safeRoomKey(roomKey)}.yjs`
}

function titleFromDoc(ydoc) {
  try {
    const json = ydoc.getMap().toJSON()
    const root = Object.values(json).find(item => item && item.isRoot)
    const raw = root && root.data && root.data.text
    if (!raw) return '未命名'
    const text = String(raw)
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return text.slice(0, 80) || '未命名'
  } catch (e) {
    return '未命名'
  }
}

function cosCall(method, params) {
  return new Promise((resolve, reject) => {
    cos[method](params, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

async function getYjsBuffer(roomKey) {
  try {
    const data = await cosCall('getObject', {
      Bucket,
      Region,
      Key: cosKey(roomKey)
    })
    const body = data.Body
    if (!body) return null
    if (Buffer.isBuffer(body)) return body
    return Buffer.from(body)
  } catch (err) {
    const code = err && (err.statusCode || err.code)
    if (code === 404 || code === 'NoSuchKey' || String(err.message).includes('404')) {
      return null
    }
    throw err
  }
}

async function putYjsBuffer(roomKey, buf) {
  await cosCall('putObject', {
    Bucket,
    Region,
    Key: cosKey(roomKey),
    Body: buf,
    ContentType: 'application/octet-stream',
    ACL: acl
  })
}

async function deleteYjsBuffer(roomKey) {
  try {
    await cosCall('deleteObject', {
      Bucket,
      Region,
      Key: cosKey(roomKey)
    })
  } catch (err) {
    const code = err && (err.statusCode || err.code)
    if (code === 404 || code === 'NoSuchKey') return
    throw err
  }
}

async function upsertRoom(roomKey, title) {
  await pool.query(
    `insert into rooms (room_key, title, cos_key, updated_at)
     values ($1, $2, $3, now())
     on conflict (room_key) do update set
       title = excluded.title,
       cos_key = excluded.cos_key,
       updated_at = now()`,
    [roomKey, title, cosKey(roomKey)]
  )
}

async function saveDoc(roomKey, ydoc) {
  if (!ydoc.getMap().size) return
  const buf = Buffer.from(Y.encodeStateAsUpdate(ydoc))
  await putYjsBuffer(roomKey, buf)
  preloadCache.set(roomKey, buf)
  await upsertRoom(roomKey, titleFromDoc(ydoc))
}

function scheduleSave(roomKey, ydoc) {
  const prev = saveTimers.get(roomKey)
  if (prev) clearTimeout(prev)
  saveTimers.set(
    roomKey,
    setTimeout(() => {
      saveTimers.delete(roomKey)
      saveDoc(roomKey, ydoc).catch(err => {
        console.error('[persist] save failed', roomKey, err.message)
      })
    }, 1500)
  )
}

async function preloadRoom(roomKey) {
  if (preloadCache.has(roomKey)) return preloadCache.get(roomKey)
  const task = getYjsBuffer(roomKey)
    .then(buf => {
      preloadCache.set(roomKey, buf)
      return buf
    })
    .catch(err => {
      preloadCache.delete(roomKey)
      throw err
    })
  preloadCache.set(roomKey, task)
  return task
}

async function ensureDoc(roomKey) {
  const key = String(roomKey || '')
  const buf = await preloadRoom(key)
  const ydoc = getYDoc(key)
  if (buf && buf.length && ydoc.getMap().size === 0) {
    Y.applyUpdate(ydoc, new Uint8Array(buf))
  }
  return ydoc
}

function shareUrl(roomKey) {
  const host = process.env.PUBLIC_HOST || '127.0.0.1'
  const webPort = Number(process.env.WEB_PORT || 8081)
  const gateway = process.env.GATEWAY === '1' || process.env.GATEWAY === 'true'
  const portPart =
    gateway && (webPort === 80 || webPort === 443) ? '' : `:${webPort}`
  return `http://${host}${portPart}/#/?room=${encodeURIComponent(roomKey)}`
}

async function getRoom(roomKey) {
  const res = await pool.query(
    `select room_key, title, cos_key, created_at, updated_at
     from rooms
     where room_key = $1`,
    [roomKey]
  )
  return res.rows[0] || null
}

function attachPersistence() {
  setPersistence({
    bindState: (docName, ydoc) => {
      const roomKey = decodeURIComponent(docName)
      const cached = preloadCache.get(roomKey)
      const buf = Buffer.isBuffer(cached) ? cached : null
      if (buf && buf.length) {
        Y.applyUpdate(ydoc, new Uint8Array(buf))
      }
      ydoc.on('update', () => scheduleSave(roomKey, ydoc))
    },
    writeState: async (docName, ydoc) => {
      const roomKey = decodeURIComponent(docName)
      const timer = saveTimers.get(roomKey)
      if (timer) {
        clearTimeout(timer)
        saveTimers.delete(roomKey)
      }
      await saveDoc(roomKey, ydoc)
    }
  })
}

async function initSchema() {
  await pool.query(`
    create table if not exists rooms (
      room_key text primary key,
      title text not null default '未命名',
      cos_key text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `)
}

async function listRooms() {
  const res = await pool.query(
    `select room_key, title, cos_key, created_at, updated_at
     from rooms
     order by updated_at desc`
  )
  return res.rows
}

async function renameRoom(roomKey, title) {
  const name = String(title || '').trim().slice(0, 80) || '未命名'
  const res = await pool.query(
    `update rooms set title = $2, updated_at = now()
     where room_key = $1
     returning room_key, title, cos_key, created_at, updated_at`,
    [roomKey, name]
  )
  return res.rows[0] || null
}

async function removeRoom(roomKey) {
  await deleteYjsBuffer(roomKey)
  preloadCache.delete(roomKey)
  await pool.query('delete from rooms where room_key = $1', [roomKey])
  const doc = docs.get(roomKey)
  if (doc) {
    docs.delete(roomKey)
    try {
      doc.destroy()
    } catch (e) {
      // ignore
    }
  }
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

async function handleApi(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return true
  }
  const mindApi = require('./mindApi')
  return mindApi.handleApi(req, res)
}

module.exports = {
  initSchema,
  attachPersistence,
  preloadRoom,
  ensureDoc,
  handleApi,
  safeRoomKey,
  listRooms,
  getRoom,
  renameRoom,
  removeRoom,
  saveDoc,
  upsertRoom,
  sendJson,
  readBody,
  shareUrl
}
