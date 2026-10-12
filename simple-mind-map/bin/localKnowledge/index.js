const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { extractDocument } = require('./extract')
const { extractionKey } = require('./mineru')
const inside = (root, file) => {
  const r = path.relative(root, file)
  return !path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep)
}
const cancelled = () =>
  Object.assign(new Error('已取消'), { name: 'AbortError' })
function waitFor(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled())
    signal.addEventListener('abort', abort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}
function createIndex({
  root,
  sourceId = process.env.LOCAL_KNOWLEDGE_SOURCE_ID || '',
  cacheDir = process.env.LOCAL_KNOWLEDGE_CACHE_DIR,
  interval = 60000,
  extract = extractDocument,
  concurrency = 2
} = {}) {
  const records = new Map(),
    queue = [],
    scopes = new Map(),
    directoryListings = new Map()
  const controller = new AbortController()
  let base,
    cacheFile,
    starting,
    refreshing,
    timer,
    persistTimer,
    active = 0,
    closed = false,
    error = '',
    generation = 0,
    lastScan = 0,
    dirty = false,
    catalogVersion = 0
  async function persist() {
    if (!cacheFile || closed || !dirty) return
    dirty = false
    const version = ++generation
    await fs.mkdir(path.dirname(cacheFile), { recursive: true })
    const tmp = cacheFile + '.' + version + '.tmp'
    await fs.writeFile(
      tmp,
      JSON.stringify({
        version: 1,
        root: base,
        records: [...records.values()]
          .filter(r => r.pages || r.error)
          .map(
            ({
              file,
              relative,
              fingerprint,
              pages,
              error,
              search,
              parserKey,
              keywords,
              factQueries
            }) => ({
              file,
              relative,
              fingerprint,
              pages,
              error,
              search,
              parserKey,
              keywords,
              factQueries
            })
          )
      })
    )
    if (version === generation) await fs.rename(tmp, cacheFile)
    else await fs.unlink(tmp).catch(() => {})
  }
  function saveLater() {
    dirty = true
    if (!persistTimer && !closed) {
      persistTimer = setTimeout(() => {
        persistTimer = null
        persist().catch(() => {
          dirty = true
          error = '缓存写入失败'
        })
      }, 2000)
      persistTimer.unref()
    }
  }
  function pump() {
    while (!closed && active < concurrency && queue.length) {
      const max = Math.max(...queue.map(job => Number(job.priority) || 0))
      if (!max && active >= Math.max(1, concurrency - 1)) break
      const i = queue.findIndex(job => (Number(job.priority) || 0) === max)
      const job = queue.splice(i, 1)[0]
      active++
      job().finally(() => {
        active--
        pump()
      })
    }
  }
  function schedule(record, priority = 0, deferPump = false) {
    record.requestedPriority = record.promise ? Math.max(Number(record.requestedPriority)||0, Number(priority)||0) : Number(priority)||0
    if (record.pages || record.error) return Promise.resolve()
    if (record.promise) {
      if (record.job)
        record.job.priority = Math.max(
          Number(record.job.priority) || 0,
          Number(priority) || 0
        )
      if (!deferPump) pump()
      return record.promise
    }
    record.promise = new Promise(resolve => {
      record.job = async () => {
        record.job = null
        if (records.get(record.file) !== record) {
          record.promise = null
          resolve()
          return
        }
        try {
          const resolved = await fs.realpath(record.file)
          if (!inside(base, resolved)) throw new Error('文件已移出资料目录')
          const stat = await fs.stat(resolved)
          if (stat.size + ':' + stat.mtimeMs !== record.fingerprint)
            throw new Error('文件读取期间发生变更')
          if (stat.size > 50 * 1024 * 1024)
            throw Object.assign(new Error('文件过大'), { code: 'too_large' })
          const pages = await extract(resolved, {
            getPriority: () => Number(record.requestedPriority)||0,
            signal: controller.signal,
            onStatus: status => {
              record.status = status
            }
          })
          const after = await fs.stat(resolved)
          if (after.size + ':' + after.mtimeMs !== record.fingerprint)
            throw new Error('文件读取期间发生变更')
          if (!pages.some(p => String(p.text || '').trim()))
            throw new Error('文件未提取到正文')
          if (records.get(record.file) === record) {
            record.pages = pages
            record.search = (
              record.relative +
              '\n' +
              pages.map(p => p.text).join('\n')
            ).replace(/\s/g, '')
          }
        } catch (e) {
          if (records.get(record.file) === record)
            record.error = e.code || 'read_failed'
        } finally {
          record.promise = null
          saveLater()
          resolve()
        }
      }
      record.job.priority = Number(priority) || 0
      queue.push(record.job)
    })
    if (!deferPump) pump()
    return record.promise
  }

  const visibleEntry = e =>
    !['.wedrive', '.ds_store', 'thumbs.db', 'desktop.ini'].includes(
      e.name.toLowerCase()
    ) && !e.name.startsWith('~$')
  const listing = children =>
    children
      .filter(visibleEntry)
      .map(e => e.name)
      .sort()
      .join('\n')
  async function scan() {
    const found = new Map()
    let changed = false
    async function walk(dir) {
      const children = await fs.readdir(dir, { withFileTypes: true })
      directoryListings.set(dir, listing(children))
      for (const entry of children) {
        if (!visibleEntry(entry) || entry.isSymbolicLink()) continue
        const file = await fs.realpath(path.join(dir, entry.name))
        if (
          !inside(base, file) ||
          (cacheDir && inside(path.resolve(cacheDir), file))
        )
          continue
        if (entry.isDirectory()) await walk(file)
        else if (entry.isFile()) {
          const stat = await fs.stat(file)
          found.set(file, {
            file,
            relative: path.relative(base, file).split(path.sep).join('/'),
            fingerprint: stat.size + ':' + stat.mtimeMs,
            parserKey: extractionKey(file)
          })
        }
      }
    }
    await walk(base)
    for (const file of records.keys())
      if (!found.has(file)) {
        records.delete(file)
        changed = true
      }
    for (const [file, record] of found)
      if (
        records.get(file)?.fingerprint !== record.fingerprint ||
        records.get(file)?.parserKey !== record.parserKey
      ) {
        records.set(file, record)
        changed = true
      }
    if (changed) {
      catalogVersion++
      scopes.clear()
    }
    dirty = true
    lastScan = Date.now()
    error = ''
  }
  async function refresh({ retryErrors = false } = {}) {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        await scan()
        if (retryErrors)
          for (const r of records.values())
            if (r.error && !['unsupported', 'too_large'].includes(r.error)) {
              delete r.error
              delete r.pages
            }
        await persist()
        for (const r of records.values()) schedule(r)
      } catch (e) {
        records.clear()
        catalogVersion++
        scopes.clear()
        error = '资料目录扫描失败'
        throw e
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }
  function start() {
    if (interval && !timer) {
      timer = setInterval(
        () => (base ? refresh({ retryErrors: true }) : start()).catch(() => {}),
        interval
      )
      timer.unref()
    }
    return (starting ||= (async () => {
      base = await fs.realpath(path.resolve(root))
      if (cacheDir) {
        cacheFile = path.join(
          cacheDir,
          crypto
            .createHash('sha256')
            .update(base + '\n' + sourceId)
            .digest('hex') + '.json'
        )
        try {
          const saved = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
          if (saved.version === 1 && saved.root === base)
            for (const r of saved.records)
              if (inside(base, r.file)) {
                if (!r.parserKey && extractionKey(r.file) === 'local-1')
                  r.parserKey = 'local-1'
                records.set(r.file, r)
              }
        } catch {}
      }
      await refresh()
    })().catch(e => {
      starting = null
      throw e
    }))
  }
  function prioritize(entries, priority = 1) {
    for (const r of entries) schedule(r, priority, true)
    pump()
  }
  function scoped(key, predicate) {
    if (!scopes.has(key))
      scopes.set(key, [...records.values()].filter(predicate))
    return scopes.get(key)
  }
  async function verify(entries) {
    const dirs = new Set(base ? [base] : [])
    for (const r of entries) {
      let dir = path.dirname(r.file)
      while (inside(base, dir)) {
        dirs.add(dir)
        if (dir === base) break
        dir = path.dirname(dir)
      }
    }
    for (const dir of dirs) {
      try {
        if (
          listing(await fs.readdir(dir, { withFileTypes: true })) !==
          directoryListings.get(dir)
        )
          return false
      } catch {
        return false
      }
    }
    const results = await Promise.all(
      entries.map(async r => {
        try {
          const stat = await fs.stat(r.file)
          return stat.size + ':' + stat.mtimeMs === r.fingerprint
        } catch {
          return false
        }
      })
    )
    return results.every(Boolean)
  }
  async function ensure(entries, { signal, onStatus } = {}) {
    if (signal?.aborted) throw cancelled()
    const notify = () => {
      const pending = entries.filter(r => !r.pages && !r.error)
      onStatus?.(
        pending.some(r => r.status)
          ? pending.find(r => r.status).status
          : pending.length
          ? '资料更新中，剩余 ' + pending.length + ' 个相关文件…'
          : '正在查询本地缓存…'
      )
    }
    notify()
    const ticker = setInterval(notify, 1000)
    ticker.unref()
    try {
      await waitFor(Promise.all(entries.map(r => schedule(r, 2))), signal)
      await persist().catch(() => {
        dirty = true
        error = '缓存写入失败'
      })
    } finally {
      clearInterval(ticker)
    }
  }
  return {
    start,
    refresh,
    ensure,
    prioritize,
    markDirty: saveLater,
    scoped,
    verify,
    entries: () => [...records.values()],
    status: () => ({
      state: error
        ? 'error'
        : !lastScan
        ? 'building'
        : active || queue.length
        ? 'updating'
        : 'ready',
      pendingFiles: [...records.values()].filter(r => !r.pages && !r.error)
        .length,
      lastScan,
      error
    }),
    close: () => {
      clearTimeout(persistTimer)
      closed = true
      clearInterval(timer)
      controller.abort()
    }
  }
}
module.exports = { createIndex }
