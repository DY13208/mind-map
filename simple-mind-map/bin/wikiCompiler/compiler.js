const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { syncDir } = require('../knowledge/manifestStore')
const { safeId, hash } = require('../knowledge/utils')

function topicSlug(roomId, nodeUid) {
  return 'map-' + hash([roomId, String(nodeUid)]).slice(0, 40)
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
async function atomicJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(data) + '\n'); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, file)
    await syncDir(path.dirname(file))
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}
async function publishRoom(outputDir, input) {
  const roomDir = path.join(outputDir, 'rooms', safeId(input.roomId))
  const sourceHash = hash(input)
  const current = await readJson(path.join(roomDir, 'current.json'))
  if (current && current.sourceHash === sourceHash && await fs.stat(path.join(roomDir, 'generations', safeId(current.generation), 'bundle.json')).catch(() => null)) {
    return { changed: false, generation: current.generation }
  }
  const generation = randomUUID()
  const publishedAt = new Date().toISOString()
  const topics = input.topics.map(topic => ({ ...topic, roomId: input.roomId,
    roomTitle: input.title, slug: topicSlug(input.roomId, topic.nodeUid),
    version: input.version, sourceRevision: input.revision,
    contentHash: hash(topic.markdown), publishedAt }))
  const bundle = { format: 1, roomId: input.roomId, title: input.title, version: input.version,
    revision: input.revision, sourceHash, publishedAt, topics }
  const target = path.join(roomDir, 'generations', generation)
  await fs.mkdir(target, { recursive: true })
  await atomicJson(path.join(target, 'bundle.json'), bundle)
  await syncDir(path.dirname(target))
  await syncDir(roomDir)
  await syncDir(path.dirname(roomDir))
  await syncDir(outputDir)
  await atomicJson(path.join(roomDir, 'current.json'), { format: 1, generation, sourceHash, publishedAt })
  return { changed: true, generation, slugs: topics.map(t => t.slug) }
}
async function removeRoom(outputDir, roomId) {
  // Retain old generations for recovery, but remove the only serving pointer.
  const dir = path.join(outputDir, 'rooms', safeId(roomId))
  await fs.rm(path.join(dir, 'current.json'), { force: true })
  if (await fs.stat(dir).catch(() => null)) await syncDir(dir)
}
module.exports = { topicSlug, readJson, atomicJson, publishRoom, removeRoom }
