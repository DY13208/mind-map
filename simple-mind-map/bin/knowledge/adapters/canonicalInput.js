const fs = require('fs/promises')
const path = require('path')
const { safeId, hash } = require('../utils')
const { readManifest } = require('../manifestStore')
async function readCanonical(outputDir, roomId) {
  const dir = path.join(path.resolve(outputDir), safeId(roomId))
  // Adapters NEVER consume a partially published generation.
  try { await fs.access(path.join(dir, '.transaction')); throw new Error('Publication pending; retry') }
  catch (err) { if (err.code !== 'ENOENT') throw err }
  const manifest = await readManifest(dir)
  if (!manifest) throw new Error('Canonical knowledge not compiled')
  const documents = []
  for (const [file, metadata] of Object.entries(manifest.documents)) {
    if (file !== 'README.md' && !/^branches\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.md$/.test(file)) throw new Error('Unsafe canonical document path')
    const text = await fs.readFile(path.join(dir, file), 'utf8')
    if (hash(text) !== metadata.fileHash) throw new Error('Canonical checksum changed; retry')
    documents.push({ file, text, ...metadata })
  }
  const again = await readManifest(dir)
  try { await fs.access(path.join(dir, '.transaction')); throw new Error('Publication pending; retry') }
  catch (err) { if (err.code !== 'ENOENT') throw err }
  if (again.sourceHash !== manifest.sourceHash || again.lastSourceRevision !== manifest.lastSourceRevision || again.lastCompiledVersion !== manifest.lastCompiledVersion) throw new Error('Canonical version changed; retry')
  return { manifest, documents }
}
module.exports = { readCanonical }
