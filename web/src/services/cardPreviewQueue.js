import { getCurrentUser } from '../utils/auth'

const cache = new Map()
const jobs = new Map()
const pending = []
const MAX_ACTIVE = 4
const MAX_ENTRIES = 128
const MAX_BYTES = 4 * 1024 * 1024
let active = 0
let cacheBytes = 0
let principal
let epoch = 0

function aborted() {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function scope() {
  const user = getCurrentUser()
  // Authentication refresh/logout changes this object. Retire both fulfilled
  // content and pending subscriptions even when the next login has the same ID.
  if (user !== principal) {
    principal = user
    epoch++
    cache.clear()
    cacheBytes = 0
    jobs.forEach(job => job.subscribers.forEach(sub => sub.cancel()))
  }
  return JSON.stringify([epoch, user && (user.corpId || user.corp_id) || '', user && user.id || ''])
}

function keyFor(room, identity) {
  return JSON.stringify([identity, room.roomKey || room.id || '',
    Number(room.revision || 0), String(room.generation || room.nodeCountsGeneration || '0'),
    room.contentUpdatedAt || room.updatedAt || '', room.role || '',
    room.canView !== false, !!room.canEdit, !!room.canManage])
}

function remember(key, sketch) {
  const bytes = new TextEncoder().encode(JSON.stringify(sketch)).byteLength
  if (bytes > MAX_BYTES) return
  const old = cache.get(key)
  if (old) cacheBytes -= old.bytes
  cache.delete(key)
  cache.set(key, { sketch, bytes })
  cacheBytes += bytes
  while (cache.size > MAX_ENTRIES || cacheBytes > MAX_BYTES) {
    const oldest = cache.keys().next().value
    cacheBytes -= cache.get(oldest).bytes
    cache.delete(oldest)
  }
}

export function cachedCardPreview(room) {
  const key = keyFor(room, scope())
  const value = cache.get(key)
  if (!value) return null
  cache.delete(key)
  cache.set(key, value)
  return value.sketch
}

function pump() {
  while (active < MAX_ACTIVE && pending.length) {
    const job = pending.shift()
    if (!job.subscribers.size) continue
    active++
    job.started = true
    Promise.resolve().then(() => job.load(job.room.roomKey || job.room.id, { signal: job.controller.signal }))
      .then(preview => {
        if (job.controller.signal.aborted || !job.subscribers.size) return
        const sketch = preview && preview.sketch
        if (!sketch) throw new Error('预览内容无效')
        // Use response revision/stamps, never the component's current props.
        const actual = { ...job.room, ...preview,
          contentUpdatedAt: preview.contentUpdatedAt || preview.updatedAt || job.room.contentUpdatedAt || '' }
        if (job.identity === scope()) remember(keyFor(actual, job.identity), sketch)
        if (jobs.get(job.key) === job) jobs.delete(job.key)
        job.subscribers.forEach(sub => sub.resolve(preview))
      }, error => {
        if (jobs.get(job.key) === job) jobs.delete(job.key)
        if (error.statusCode === 401 || error.statusCode === 403) {
          cache.clear()
          cacheBytes = 0
        }
        job.subscribers.forEach(sub => sub.reject(error))
      }).catch(error => job.subscribers.forEach(sub => sub.reject(error)))
      .finally(() => {
        if (jobs.get(job.key) === job) jobs.delete(job.key)
        job.subscribers.clear()
        active--
        pump()
      })
  }
}

export function subscribeCardPreview(room, load) {
  const identity = scope()
  const key = keyFor(room, identity)
  let job = jobs.get(key)
  if (!job) {
    job = { key, identity, room: { ...room }, load, controller: new AbortController(), subscribers: new Set(), started: false }
    jobs.set(key, job)
    pending.push(job)
  }
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  const sub = { resolve, reject, cancel() {
    if (!job.subscribers.delete(sub)) return
    reject(aborted())
    if (!job.subscribers.size) {
      job.controller.abort()
      if (jobs.get(key) === job) jobs.delete(key)
    }
  } }
  job.subscribers.add(sub)
  pump()
  return { promise, cancel: sub.cancel }
}
