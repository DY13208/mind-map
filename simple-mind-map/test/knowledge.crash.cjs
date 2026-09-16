const path = require('path')
const fs = require('fs/promises')
const { KnowledgeCompiler } = require('../bin/knowledge/compiler')
const storage = require('../bin/storage')
async function main() {
  const [dir, roomId, point] = process.argv.slice(2)
  const compiler = new KnowledgeCompiler({ pool: storage.getPool(), outputDir: dir })
  await compiler.compile(roomId, {
    beforeWrite: file => { if (point === 'before-manifest' && file === 'manifest.json') process.exit(73) },
    afterWrite: file => { if (point === 'after-markdown' && file.startsWith('branches/')) process.exit(73) },
    beforeSwap: () => { if (point === 'before-swap') process.exit(73) },
    afterSwap: () => { if (point === 'after-swap') process.exit(73) }
  })
  await storage.getPool().end()
  throw new Error('Expected injected crash did not happen')
}
main().catch(err => { console.error(err.message); process.exit(1) })
