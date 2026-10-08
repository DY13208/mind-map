const fs = require('fs/promises')
const path = require('path')
const { randomUUID } = require('crypto')
const { safeId } = require('./utils')

const DEFAULT_MCP_READ_GID = 1000
const PRIVATE_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const SHARED_DIRECTORY_MODE = 0o2750
const SHARED_FILE_MODE = 0o640

function mcpReadGid(env = process.env) {
  const raw = String(env.KNOWLEDGE_MCP_GID || DEFAULT_MCP_READ_GID)
  const gid = Number(raw)
  if (!Number.isInteger(gid) || gid < 0) throw new Error('Invalid KNOWLEDGE_MCP_GID')
  return gid
}

function roomDirectory(root, roomId) {
  const base = path.resolve(root)
  const dir = path.resolve(base, safeId(roomId))
  if (path.dirname(dir) !== base) throw new Error('Unsafe canonical room path')
  return dir
}

function sharedMode(mode) {
  // Windows bind mounts use ACLs instead of POSIX group bits. Keep them
  // readable there while Linux uses the MCP service's shared group only.
  if (process.platform !== 'win32') return mode
  return mode === SHARED_DIRECTORY_MODE ? 0o755 : 0o644
}

async function lstatRegular(targetPath, kind) {
  const stat = await fs.lstat(targetPath)
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('Unsafe canonical permission target')
  }
  return stat
}

async function lstatOptional(targetPath) {
  try { return await fs.lstat(targetPath) }
  catch (err) { if (err.code === 'ENOENT') return null; throw err }
}

async function assertRoomPathsAreRegular(roomDir) {
  const roomStat = await lstatOptional(roomDir)
  if (!roomStat) return false
  if (roomStat.isSymbolicLink() || !roomStat.isDirectory()) throw new Error('Unsafe canonical room path')
  for (const [targetPath, kind] of [
    [path.join(roomDir, 'manifest.json'), 'file'],
    [path.join(roomDir, 'branches'), 'directory']
  ]) {
    const stat = await lstatOptional(targetPath)
    if (stat && (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()))) {
      throw new Error('Unsafe canonical permission target')
    }
  }
  return true
}

async function setSharedPermissions(targetPath, kind, gid) {
  let stat = await lstatRegular(targetPath, kind)
  if (process.platform !== 'win32' && stat.gid !== gid) {
    // Preserve the existing owner. Avoid chown when the target group is
    // already correct so non-root publishers can perform idempotent updates.
    await fs.chown(targetPath, stat.uid, gid)
    stat = await lstatRegular(targetPath, kind)
  }
  const mode = sharedMode(kind === 'directory' ? SHARED_DIRECTORY_MODE : SHARED_FILE_MODE)
  if ((stat.mode & 0o7777) !== mode) await fs.chmod(targetPath, mode)
}

function hasCanonicalFilePermissions(stat, gid) {
  if (process.platform === 'win32') return true
  return stat.gid === gid && (stat.mode & 0o7777) === SHARED_FILE_MODE
}

async function copyWithMetadata(source, destination, stat) {
  await fs.copyFile(source, destination)
  await fs.utimes(destination, stat.atime, stat.mtime)
}

async function ensureRoomFilePermissions(filePath, gid) {
  const stat = await lstatRegular(filePath, 'file')
  if (hasCanonicalFilePermissions(stat, gid) && process.platform !== 'win32') return
  if (process.platform === 'win32') {
    await setSharedPermissions(filePath, 'file', gid)
    return
  }
  if (stat.nlink > 1) {
    // chmod/chown on a hard-linked file changes every link. Replace only this
    // room's link before changing access, keeping external links untouched.
    const tmp = filePath + '.' + randomUUID() + '.permission.tmp'
    try {
      await copyWithMetadata(filePath, tmp, stat)
      await setSharedPermissions(tmp, 'file', gid)
      await fs.rename(tmp, filePath)
      await syncDir(path.dirname(filePath))
    } finally {
      await fs.rm(tmp, { force: true })
    }
    return
  }
  await setSharedPermissions(filePath, 'file', gid)
}

async function ensureCanonicalRoot(root, gid) {
  await fs.mkdir(root, { recursive: true, mode: PRIVATE_MODE })
  await setSharedPermissions(root, 'directory', gid)
}

function target(roomDir, relative) {
  if (relative !== 'README.md' && relative !== 'manifest.json' && !/^branches\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.md$/.test(relative)) throw new Error('Unsafe canonical file path')
  return path.join(roomDir, relative)
}
function transactionDir(roomDir) {
  return path.join(path.dirname(roomDir), '.transactions', path.basename(roomDir))
}
async function syncDir(dir) {
  let handle
  try { handle = await fs.open(dir, 'r'); await handle.sync() }
  catch (err) { if (!['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(err.code)) throw err }
  finally { if (handle) await handle.close() }
}
async function writeDurable(file, text, mode = PRIVATE_FILE_MODE) {
  const handle = await fs.open(file, 'wx', mode)
  try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
}
async function atomicWrite(file, text, mode = PRIVATE_FILE_MODE) {
  const tmp = file + '.' + randomUUID() + '.tmp'
  try { await writeDurable(tmp, text, mode); await fs.rename(tmp, file); await syncDir(path.dirname(file)) }
  finally { await fs.rm(tmp, { force: true }) }
}
async function exists(file) {
  try { return await fs.stat(file) } catch (err) { if (err.code === 'ENOENT') return null; throw err }
}
async function readManifest(roomDir) {
  const filePath = path.join(roomDir, 'manifest.json')
  let text
  try {
    await lstatRegular(filePath, 'file')
    text = await fs.readFile(filePath, 'utf8')
  }
  catch (err) { if (err.code === 'ENOENT') return null; throw err }
  try { return JSON.parse(text) } catch { return null }
}

// Node has no portable atomic directory exchange. The two directory renames
// below can briefly make the room path unavailable, but NEVER expose a mixture
// of old/new documents. A durable journal restores the old directory if the
// second rename has not committed. Once the new directory exists at its final
// path, documents + manifest are complete and that rename is the commit.
async function recover(roomDir) {
  const txn = transactionDir(roomDir)
  let journal
  try { journal = JSON.parse(await fs.readFile(path.join(txn, 'journal.json'), 'utf8')) }
  catch (err) {
    if (err.code !== 'ENOENT') throw err
    await fs.rm(txn, { recursive: true, force: true })
    return false
  }
  const current = await readManifest(roomDir)
  if (current?.publicationId !== journal.publicationId) {
    const backup = path.join(txn, 'backup')
    if (await exists(backup)) {
      if (await exists(roomDir)) throw new Error('Knowledge recovery found an unexpected room directory')
      await fs.rename(backup, roomDir)
    }
    if (journal.oldExists) await fs.rm(path.join(roomDir, '.transaction'), { recursive: true, force: true })
    else await fs.rm(roomDir, { recursive: true, force: true })
    await syncDir(path.dirname(roomDir))
  }
  await fs.rm(txn, { recursive: true, force: true })
  await syncDir(path.dirname(txn))
  return true
}

async function publish(roomDir, writes, deletes, manifest, options = {}) {
  const absoluteRoomDir = path.resolve(roomDir)
  const root = path.dirname(absoluteRoomDir)
  if (roomDirectory(root, path.basename(absoluteRoomDir)) !== absoluteRoomDir) {
    throw new Error('Unsafe canonical room path')
  }
  await assertRoomPathsAreRegular(absoluteRoomDir)
  const gid = mcpReadGid()
  await ensureCanonicalRoot(root, gid)
  await recover(roomDir)
  await assertRoomPathsAreRegular(absoluteRoomDir)
  const oldExists = !!await exists(roomDir)
  if (oldExists) await repairRoomPermissions(root, path.basename(absoluteRoomDir))
  const txn = transactionDir(roomDir)
  await fs.mkdir(path.dirname(txn), { recursive: true, mode: 0o700 })
  await fs.mkdir(txn, { mode: 0o700 })
  const publicationId = randomUUID()
  const stage = path.join(txn, 'stage')
  let committed = false
  try {
    await atomicWrite(path.join(txn, 'journal.json'), JSON.stringify({ publicationId, oldExists }))
    await syncDir(path.dirname(txn))
    await fs.mkdir(roomDir, { recursive: true, mode: 0o700 })
    await fs.mkdir(path.join(roomDir, '.transaction'), { mode: 0o700 })
    await fs.mkdir(path.join(stage, 'branches'), { recursive: true, mode: PRIVATE_MODE })
    // Machine-owned files are immutable between publications. Hard links keep
    // unchanged files' exact inode/content/mtime without reading or rewriting.
    // A document without MCP group-read access is copied into this private
    // staging area so its old inode (possibly shared elsewhere) is untouched.
    for (const file of Object.keys(manifest.documents)) {
      if (writes.has(file) || deletes.includes(file)) continue
      const source = target(roomDir, file)
      const destination = target(stage, file)
      const sourceStat = await lstatRegular(source, 'file')
      if (hasCanonicalFilePermissions(sourceStat, gid)) {
        await fs.link(source, destination)
      } else {
        await copyWithMetadata(source, destination, sourceStat)
      }
    }
    for (const [file, text] of writes) {
      if (options.beforeWrite) await options.beforeWrite(file)
      await atomicWrite(target(stage, file), text)
      if (options.afterWrite) await options.afterWrite(file)
    }
    if (options.beforeWrite) await options.beforeWrite('manifest.json')
    await atomicWrite(target(stage, 'manifest.json'), JSON.stringify({ ...manifest, publicationId }, null, 2) + '\n')
    if (options.afterWrite) await options.afterWrite('manifest.json')
    for (const file of Object.keys(manifest.documents)) {
      await ensureRoomFilePermissions(target(stage, file), gid)
    }
    await setSharedPermissions(target(stage, 'manifest.json'), 'file', gid)
    await setSharedPermissions(path.join(stage, 'branches'), 'directory', gid)
    await setSharedPermissions(stage, 'directory', gid)
    await syncDir(path.join(stage, 'branches'))
    await syncDir(stage)
    await fs.rename(roomDir, path.join(txn, 'backup'))
    await syncDir(path.dirname(roomDir))
    await syncDir(txn)
    if (options.beforeSwap) await options.beforeSwap()
    await fs.rename(stage, roomDir)
    committed = true
    await syncDir(path.dirname(roomDir))
    if (options.afterSwap) await options.afterSwap()
  } catch (err) {
    if (!committed) { await recover(roomDir); throw err }
    // The directory commit is complete. A fsync/cleanup error after this point
    // leaves a recoverable journal, rather than claiming an old version.
    return
  }
  await fs.rm(txn, { recursive: true, force: true }).catch(() => {})
}

async function repairRoomPermissions(root, roomId) {
  const absoluteRoot = path.resolve(root)
  const roomDir = roomDirectory(absoluteRoot, roomId)
  const gid = mcpReadGid()
  await lstatRegular(absoluteRoot, 'directory')
  await lstatRegular(roomDir, 'directory')
  if (await lstatOptional(path.join(roomDir, '.transaction')) ||
      await lstatOptional(path.join(transactionDir(roomDir), 'journal.json'))) {
    throw new Error('Canonical room publication is in progress')
  }
  await assertRoomPathsAreRegular(roomDir)
  const branchDir = path.join(roomDir, 'branches')
  const branchStat = await lstatOptional(branchDir)
  const manifestPath = target(roomDir, 'manifest.json')
  const manifestStat = await lstatOptional(manifestPath)
  const manifest = manifestStat ? await readManifest(roomDir) : null
  const files = Object.keys(manifest?.documents || {}).map(file => target(roomDir, file))
  for (const file of files) await lstatRegular(file, 'file')
  if (manifestStat) await lstatRegular(manifestPath, 'file')

  // Validate every path before mutating any ownership or mode. This ensures a
  // malformed manifest or symlink cannot leave a partially repaired room.
  await setSharedPermissions(absoluteRoot, 'directory', gid)
  await setSharedPermissions(roomDir, 'directory', gid)
  if (branchStat) await setSharedPermissions(branchDir, 'directory', gid)
  for (const file of files) await ensureRoomFilePermissions(file, gid)
  if (manifestStat) await ensureRoomFilePermissions(manifestPath, gid)
  return { roomId: safeId(roomId), files: Object.keys(manifest?.documents || {}).length }
}

module.exports = {
  readManifest,
  recover,
  publish,
  exists,
  atomicWrite,
  syncDir,
  transactionDir,
  roomDirectory,
  repairRoomPermissions
}
