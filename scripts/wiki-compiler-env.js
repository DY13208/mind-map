const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function ensureCompilerEnv(root = path.resolve(__dirname, '..'), env = process.env) {
  const file = path.join(root, '.secrets', 'wiki-compiler.env')
  const stored = {}
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^(WIKI_COMPILER_INTERNAL_SECRET|KNOWLEDGE_MCP_JWT_SECRET)=(.+)$/.exec(line)
    if (m) stored[m[1]] = m[2]
  }
  let changed = false
  for (const key of ['WIKI_COMPILER_INTERNAL_SECRET', 'KNOWLEDGE_MCP_JWT_SECRET']) {
    if (!env[key]) env[key] = stored[key] || crypto.randomBytes(32).toString('hex')
    if (stored[key] !== env[key]) { stored[key] = env[key]; changed = true }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '# Independent wiki-compiler credentials; keep this file private.\n' + Object.entries(stored).map(([k,v]) => k + '=' + v).join('\n') + '\n', { mode: 0o600 })
  }
  return file
}
module.exports = { ensureCompilerEnv }
if (require.main === module) console.log('Credentials ready: ' + ensureCompilerEnv())
