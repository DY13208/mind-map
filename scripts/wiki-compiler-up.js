// Standalone deployment: no Docmost service, secrets, or Wiki compose extension.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const runtime = path.join(root, 'docker', 'runtime-config.local.js')
// Docker bind mounts require a file, even on a fresh checkout.
if (fs.existsSync(runtime) && fs.statSync(runtime).isDirectory() && fs.readdirSync(runtime).length === 0) fs.rmdirSync(runtime)
if (!fs.existsSync(runtime)) fs.copyFileSync(path.join(root, 'docker', 'runtime-config.js'), runtime)
if (!fs.readFileSync(runtime, 'utf8').includes('graphServiceUrl')) fs.appendFileSync(runtime, "\nwindow.__MIND_MAP_RUNTIME__.graphServiceUrl = '/wiki-compiler/'\n")
const env = { ...process.env }
const file = path.join(root, '.env')
if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
}
require('./wiki-compiler-env').ensureCompilerEnv(root, env)
env.KNOWLEDGE_COMPILER_ENABLED = 'false'
env.KNOWLEDGE_DOCMOST_TOOLS_ENABLED = 'false'
env.DOCMOST_SYNC_ENABLED = 'false'
env.WIKI_MINDMAP_AUTO_SYNC = 'false'
for (const key of Object.keys(env)) if (/^DOCMOST_|^WIKI_MINDMAP_HOOK_SECRET$/.test(key)) env[key] = ''
env.DOCMOST_SYNC_ENABLED = 'false'
for (const key of ['DOCMOST_DATABASE_URL','DOCMOST_APP_SECRET','DOCMOST_SSO_SECRET']) env[key] = ''
const child = spawn('docker', ['compose', '-f', 'docker-compose.yml', 'up', '-d', '--build',
  'postgres', 'redis', 'wiki-graph', 'knowledge-mcp', 'app'], { cwd: root, env, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code || 0 })
