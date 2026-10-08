'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const store = require('./manifestStore')
const repairCli = require('./repairCanonicalPermissions')

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-manifest-store-'))
  try { await run(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

async function withReadGroup(run) {
  const previous = process.env.KNOWLEDGE_MCP_GID
  if (process.platform !== 'win32' && typeof process.getgid === 'function') {
    // Root can exercise the production default group (1000), including chown.
    // Non-root local runs use their own group so the suite remains portable.
    const gid = typeof process.getuid === 'function' && process.getuid() === 0
      ? 1000
      : process.getgid()
    process.env.KNOWLEDGE_MCP_GID = String(gid)
  }
  try { await run() } finally {
    if (previous == null) delete process.env.KNOWLEDGE_MCP_GID
    else process.env.KNOWLEDGE_MCP_GID = previous
  }
}

async function assertShared(target, kind) {
  await fs.access(target, fsSync.constants.R_OK)
  if (process.platform === 'win32') return
  const stat = await fs.stat(target)
  const mode = stat.mode & 0o7777
  assert.equal(stat.gid, Number(process.env.KNOWLEDGE_MCP_GID || 1000))
  assert.equal(mode, kind === 'directory' ? 0o2750 : 0o640)
}

test('publish creates MCP-readable room files and keeps already-correct files linked', async () => {
  await withReadGroup(async () => withTempDir(async temp => {
    const root = path.join(temp, 'knowledge')
    const roomId = 'room-readable'
    const roomDir = store.roomDirectory(root, roomId)
    const writes = new Map([
      ['README.md', '# Room\n'],
      ['branches/topic.md', '# Topic\n']
    ])
    const manifest = { documents: { 'README.md': {}, 'branches/topic.md': {} } }

    await store.publish(roomDir, writes, [], manifest)
    await assertShared(root, 'directory')
    await assertShared(roomDir, 'directory')
    await assertShared(path.join(roomDir, 'branches'), 'directory')
    await assertShared(path.join(roomDir, 'manifest.json'), 'file')
    const branchFile = path.join(roomDir, 'branches', 'topic.md')
    await assertShared(branchFile, 'file')

    const before = await fs.stat(branchFile)
    await store.publish(roomDir, new Map(), [], manifest)
    const after = await fs.stat(branchFile)
    if (process.platform !== 'win32') {
      assert.equal(after.ino, before.ino)
      assert.equal(after.nlink, before.nlink)
    }
  }))
})

test('repair fixes one legacy private room without changing a hard-linked external file or sibling room', async () => {
  await withReadGroup(async () => withTempDir(async temp => {
    const root = path.join(temp, 'knowledge')
    const roomId = 'room-legacy'
    const roomDir = path.join(root, roomId)
    const branches = path.join(roomDir, 'branches')
    const externalRoom = path.join(root, 'room-sibling')
    await fs.mkdir(branches, { recursive: true, mode: 0o700 })
    await fs.mkdir(externalRoom, { mode: 0o700 })
    await fs.writeFile(path.join(roomDir, 'README.md'), '# Room\n', { mode: 0o600 })
    await fs.writeFile(path.join(branches, 'topic.md'), '# Topic\n', { mode: 0o600 })
    await fs.writeFile(path.join(roomDir, 'manifest.json'), JSON.stringify({
      documents: { 'README.md': {}, 'branches/topic.md': {} }
    }), { mode: 0o600 })
    await fs.chmod(root, 0o700)
    await fs.chmod(roomDir, 0o700)
    await fs.chmod(branches, 0o700)
    if (process.platform !== 'win32') {
      const readme = path.join(roomDir, 'README.md')
      const readmeStat = await fs.stat(readme)
      const targetGid = Number(process.env.KNOWLEDGE_MCP_GID || 1000)
      if (readmeStat.gid !== targetGid) await fs.chown(readme, readmeStat.uid, targetGid)
      await fs.chmod(readme, 0o644)
    }
    const branchFile = path.join(branches, 'topic.md')
    const externalLink = path.join(temp, 'outside-topic.md')
    if (process.platform !== 'win32') await fs.link(branchFile, externalLink)

    const beforeSibling = await fs.stat(externalRoom)
    const result = await store.repairRoomPermissions(root, roomId)
    assert.equal(result.roomId, roomId)
    assert.equal(result.files, 2)
    await assertShared(root, 'directory')
    await assertShared(roomDir, 'directory')
    await assertShared(branches, 'directory')
    await assertShared(path.join(roomDir, 'manifest.json'), 'file')
    await assertShared(branchFile, 'file')

    const afterSibling = await fs.stat(externalRoom)
    assert.equal(afterSibling.mode, beforeSibling.mode)
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(externalLink)).mode & 0o7777, 0o600)
      assert.notEqual((await fs.stat(branchFile)).ino, (await fs.stat(externalLink)).ino)
    }
  }))
})

test('room permission repair rejects path traversal and room symlinks', async () => {
  await withReadGroup(async () => withTempDir(async temp => {
    const root = path.join(temp, 'knowledge')
    const outside = path.join(temp, 'outside')
    await fs.mkdir(root)
    await fs.mkdir(outside)
    await assert.rejects(store.repairRoomPermissions(root, '../outside'), /Unsafe knowledge path identifier/)
    assert.throws(() => store.roomDirectory(root, '../outside'), /Unsafe knowledge path identifier/)

    try {
      await fs.symlink(outside, path.join(root, 'room-link'), 'dir')
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error
      return
    }
    await assert.rejects(store.repairRoomPermissions(root, 'room-link'), /Unsafe canonical permission target/)
  }))
})

test('publish and repair reject symlinked manifest and branches before changing permissions', async t => {
  await withReadGroup(async () => withTempDir(async temp => {
    const root = path.join(temp, 'knowledge')
    const roomId = 'room-symlinks'
    const roomDir = path.join(root, roomId)
    const outside = path.join(temp, 'outside')
    await fs.mkdir(path.join(roomDir, 'branches'), { recursive: true, mode: 0o700 })
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'topic.md'), '# Outside\n')
    await fs.writeFile(path.join(roomDir, 'manifest.json'), JSON.stringify({
      documents: { 'branches/topic.md': {} }
    }))
    const rootMode = (await fs.stat(root)).mode & 0o7777
    const roomMode = (await fs.stat(roomDir)).mode & 0o7777

    await fs.rm(path.join(roomDir, 'branches'), { recursive: true })
    try { await fs.symlink(outside, path.join(roomDir, 'branches'), 'dir') }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('directory symlinks are unavailable')
      throw error
    }
    await assert.rejects(store.repairRoomPermissions(root, roomId), /Unsafe canonical permission target/)
    await assert.rejects(store.publish(roomDir, new Map(), [], { documents: {} }), /Unsafe canonical permission target/)
    assert.equal((await fs.stat(root)).mode & 0o7777, rootMode)
    assert.equal((await fs.stat(roomDir)).mode & 0o7777, roomMode)

    await fs.rm(path.join(roomDir, 'branches'))
    await fs.mkdir(path.join(roomDir, 'branches'), { mode: 0o700 })
    await fs.rm(path.join(roomDir, 'manifest.json'))
    const outsideManifest = path.join(outside, 'manifest.json')
    await fs.writeFile(outsideManifest, JSON.stringify({ documents: {} }))
    try { await fs.symlink(outsideManifest, path.join(roomDir, 'manifest.json')) }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('file symlinks are unavailable')
      throw error
    }
    await assert.rejects(store.readManifest(roomDir), /Unsafe canonical permission target/)
    await assert.rejects(store.repairRoomPermissions(root, roomId), /Unsafe canonical permission target/)
    await assert.rejects(store.publish(roomDir, new Map(), [], { documents: {} }), /Unsafe canonical permission target/)
    assert.equal((await fs.stat(root)).mode & 0o7777, rootMode)
    assert.equal((await fs.stat(roomDir)).mode & 0o7777, roomMode)
  }))
})

test('permission maintenance requires an explicit room selection or --all', () => {
  assert.deepEqual(repairCli.parseSelection(['--rooms', 'room-a,room-b']), {
    all: false,
    roomIds: ['room-a', 'room-b']
  })
  assert.deepEqual(repairCli.parseSelection(['--all']), { all: true })
  assert.throws(() => repairCli.parseSelection([]), /Usage:/)
  assert.throws(() => repairCli.parseSelection(['--rooms', '../outside']), /Unsafe knowledge path identifier/)
})
