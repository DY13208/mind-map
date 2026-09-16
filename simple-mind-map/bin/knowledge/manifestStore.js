const fs = require('fs/promises')
const path = require('path')
const { randomUUID } = require('crypto')

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
async function writeDurable(file, text) {
  const handle = await fs.open(file, 'wx', 0o600)
  try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
}
async function atomicWrite(file, text) {
  const tmp = file + '.' + randomUUID() + '.tmp'
  try { await writeDurable(tmp, text); await fs.rename(tmp, file); await syncDir(path.dirname(file)) }
  finally { await fs.rm(tmp, { force: true }) }
}
async function exists(file) {
  try { return await fs.stat(file) } catch (err) { if (err.code === 'ENOENT') return null; throw err }
}
async function readManifest(roomDir) {
  try { return JSON.parse(await fs.readFile(path.join(roomDir, 'manifest.json'), 'utf8')) }
  catch (err) { if (err.code === 'ENOENT') return null; throw err }
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
  await fs.mkdir(path.dirname(roomDir), { recursive: true, mode: 0o700 })
  await recover(roomDir)
  const oldExists = !!await exists(roomDir)
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
    await fs.mkdir(path.join(stage, 'branches'), { recursive: true, mode: 0o700 })
    // Machine-owned files are immutable between publications. Hard links keep
    // unchanged files' exact inode/content/mtime without reading or rewriting.
    // If hard links are unsupported, fail safely rather than silently copying.
    for (const file of Object.keys(manifest.documents)) {
      if (!writes.has(file) && !deletes.includes(file)) await fs.link(target(roomDir, file), target(stage, file))
    }
    for (const [file, text] of writes) {
      if (options.beforeWrite) await options.beforeWrite(file)
      await atomicWrite(target(stage, file), text)
      if (options.afterWrite) await options.afterWrite(file)
    }
    if (options.beforeWrite) await options.beforeWrite('manifest.json')
    await atomicWrite(target(stage, 'manifest.json'), JSON.stringify({ ...manifest, publicationId }, null, 2) + '\n')
    if (options.afterWrite) await options.afterWrite('manifest.json')
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
module.exports = { readManifest, recover, publish, exists, atomicWrite, syncDir, transactionDir }
