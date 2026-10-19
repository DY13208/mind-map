// 文件夹上传：收集本地目录（<input webkitdirectory> 或拖拽目录），按相对路径在目标文件夹下重建目录，
// 再把每个文件交给现有上传队列（重试 / 去重 / 429 退避都由队列负责）。
// 文件夹按层创建：父级全部完成后才建子级；同一路径在一次上传里只创建一次，
// 后端 POST /folders { reuse: true } 对同名同级文件夹幂等（并发也只建一个）。

export const MAX_FOLDER_DEPTH = 32
export const MAX_FOLDERS = 1000
export const MAX_SCAN_ENTRIES = 20000

const SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', 'ehthumbs.db', 'ehthumbs_vista.db', 'icon\r'])
const SYSTEM_DIRS = new Set(['__macosx', '$recycle.bin', 'system volume information'])

export function splitPath(p) {
  return String(p || '').replace(/\\/g, '/').split('/').filter(s => s && s !== '.')
}

// 隐藏或系统文件：任意一级以 . 开头、系统目录、Office 锁文件 ~$xxx、.DS_Store / Thumbs.db / desktop.ini
export function isIgnoredPath(p) {
  const parts = splitPath(p)
  if (!parts.length) return true
  const name = parts[parts.length - 1]
  if (SYSTEM_FILES.has(name.toLowerCase()) || name.startsWith('~$')) return true
  return parts.some(s => s.startsWith('.') || SYSTEM_DIRS.has(s.toLowerCase()))
}

export function isIgnoredDir(p) {
  return splitPath(p).some(s => s.startsWith('.') || SYSTEM_DIRS.has(s.toLowerCase()))
}

// <input webkitdirectory> 的 File 带 webkitRelativePath（"根目录/子目录/a.pdf"）
export function entriesFromInput(files) {
  return Array.from(files || []).map(file => ({ file, path: splitPath(file.webkitRelativePath || file.name).join('/') }))
}

export function hasDirectoryEntry(dataTransfer) {
  const items = Array.from((dataTransfer && dataTransfer.items) || [])
  return items.some(i => {
    const e = i && i.kind === 'file' && typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null
    return !!(e && e.isDirectory)
  })
}

// 必须在 drop 事件里同步调用：dataTransfer 在事件结束后失效，这里先同步取出 entry，再异步遍历
export function collectDropped(dataTransfer, { maxEntries = MAX_SCAN_ENTRIES } = {}) {
  const roots = Array.from((dataTransfer && dataTransfer.items) || [])
    .map(i => (i && i.kind === 'file' && typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null))
    .filter(Boolean)
  return walkEntries(roots, { maxEntries })
}

function readAll(dir) {
  const reader = dir.createReader()
  const out = []
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries(batch => {
      if (!batch.length) return resolve(out)
      out.push(...batch)
      next()
    }, reject)
    next()
  })
}

const fileOf = entry => new Promise((resolve, reject) => entry.file(resolve, reject))

// 返回 { entries:[{file,path}], emptyDirs:[path], ignored:[path], errors:[{path,message}], truncated }
export async function walkEntries(roots, { maxEntries = MAX_SCAN_ENTRIES } = {}) {
  const entries = []
  const emptyDirs = []
  const ignored = []
  const errors = []
  let seen = 0
  let truncated = false
  const stack = roots.slice().reverse()
  while (stack.length) {
    const entry = stack.pop()
    const path = splitPath(entry.fullPath || entry.name).join('/')
    if (++seen > maxEntries) { truncated = true; break }
    if (entry.isDirectory) {
      if (isIgnoredDir(path)) { ignored.push(path + '/'); continue }
      try {
        const children = await readAll(entry)
        if (!children.length) emptyDirs.push(path)
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
      } catch (e) {
        errors.push({ path: path + '/', message: '无法读取目录' })
      }
    } else if (entry.isFile) {
      if (isIgnoredPath(path)) { ignored.push(path); continue }
      try {
        entries.push({ file: await fileOf(entry), path })
      } catch (e) {
        errors.push({ path, message: '无法读取文件' })
      }
    }
  }
  return { entries, emptyDirs, ignored, errors, truncated }
}

export function parentPath(p) {
  const parts = splitPath(p)
  return parts.slice(0, -1).join('/')
}

// 把要上传的文件和要建的目录算出来；precheck 与上传队列用同一个（大小 / 类型上限）
export function planFolderUpload(entries, { emptyDirs = [], precheck = null, maxDepth = MAX_FOLDER_DEPTH } = {}) {
  const files = []
  const ignored = []
  const invalid = []
  const dirSet = new Set()
  const addDirs = parts => { for (let i = 1; i <= parts.length; i++) dirSet.add(parts.slice(0, i).join('/')) }
  for (const { file, path } of entries || []) {
    const parts = splitPath(path || (file && file.name))
    const shown = parts.join('/')
    if (isIgnoredPath(shown)) { ignored.push(shown); continue }
    if (parts.length - 1 > maxDepth) { invalid.push({ path: shown, message: `目录层级超过 ${maxDepth} 层` }); continue }
    const pre = precheck ? precheck(file) : null
    if (pre) { invalid.push({ path: shown, message: pre.message }); continue }
    const dir = parts.slice(0, -1)
    addDirs(dir)
    files.push({ file, path: shown, dir: dir.join('/') })
  }
  for (const d of emptyDirs) {
    const parts = splitPath(d)
    if (!parts.length || isIgnoredDir(d) || parts.length > maxDepth) continue
    addDirs(parts)
  }
  const depth = p => splitPath(p).length
  const dirs = Array.from(dirSet).sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
  return { files, dirs, ignored, invalid }
}

const RETRY_KINDS = new Set(['network', 'timeout', 'unavailable'])
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms))

async function runLimited(list, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    while (i < list.length) {
      const item = list[i++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

// dirs 必须按层排好（planFolderUpload 的输出）。create({ name, parentId }) → { id, reused }。
// 网络错误 / 超时 / 503 / 429 最多重试 retries 次：reuse 请求是幂等的，结果未知时重发不会多建文件夹。
export async function ensureFolders(dirs, { baseId = '', create, concurrency = 3, retries = 2, sleep = sleepMs, onStep = null, isCancelled = null } = {}) {
  const ids = new Map([['', baseId || '']])
  const failed = new Map()
  let created = 0
  let reused = 0
  const levels = []
  for (const d of dirs) {
    const n = splitPath(d).length
    ;(levels[n] = levels[n] || []).push(d)
  }
  for (const level of levels) {
    if (!level) continue
    await runLimited(level, concurrency, async path => {
      const parent = parentPath(path)
      if (isCancelled && isCancelled()) failed.set(path, '已取消')
      else if (!ids.has(parent)) failed.set(path, '上级文件夹没有创建成功')
      else {
        const parts = splitPath(path)
        for (let attempt = 0; ; attempt++) {
          try {
            const f = await create({ name: parts[parts.length - 1], parentId: ids.get(parent) || undefined })
            if (!f || !f.id) throw Object.assign(new Error('后端没有返回文件夹 id'), { kind: 'error' })
            ids.set(path, f.id)
            if (f.reused) reused++
            else created++
            break
          } catch (e) {
            const retry = attempt < retries && e && (RETRY_KINDS.has(e.kind) || e.status === 429)
            if (!retry) { failed.set(path, (e && e.message) || '创建失败'); break }
            await sleep(Math.min(8000, (e.retryAfterMs || 1000) * (attempt + 1)))
          }
        }
      }
      if (onStep) onStep(path)
    })
  }
  return { ids, failed, created, reused }
}

// 文件所在目录（或任一上级）没建成功的文件不上传，在汇总里列出
export function assignFolders(files, ids, failed) {
  const ready = []
  const blocked = []
  for (const f of files) {
    if (ids.has(f.dir)) ready.push({ ...f, folderId: ids.get(f.dir) || '' })
    else {
      let p = f.dir
      let reason = '目标文件夹没有创建成功'
      while (p) { if (failed.has(p)) { reason = `文件夹「${p}」创建失败：${failed.get(p)}`; break } p = parentPath(p) }
      blocked.push({ path: f.path, message: reason })
    }
  }
  return { ready, blocked }
}
