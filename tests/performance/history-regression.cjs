const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { withIsolatedPg } = require('./isolation.cjs')
const repo = path.resolve(__dirname, '../..')
const runtime = path.join(repo, 'work/performance-tdd/runtime/node_modules/node/bin/node')
const output = path.join(repo, 'work/performance-tdd/after/backend/history-regression')
const files = [
  'nodeRestoreReplay.test.js', 'nodeRestoreReplay.pg.test.js',
  'collabHistory.test.js', 'collabVisibleUndo.test.js', 'collabHydrationUndo.test.js', 'collabHttpHistoryRefresh.test.js',
  'historyPgSafety.test.js', 'collabHistory.pg.test.js', 'historyAttribution.pg.test.js', 'historyAutoConcurrency.pg.test.js',
  'directHttpParity.pg.test.js'
]
async function main() {
  fs.mkdirSync(output, { recursive: true })
  const results = []
  for (const file of files) {
    // The owned nonce is verified before each standalone legacy entrypoint.
    await withIsolatedPg(async () => {})
    const args = ['-e', "require('./tests/performance/isolation.cjs').configureIsolatedEnvironment();require(" + JSON.stringify('./simple-mind-map/test/' + file) + ')']
    const fd = fs.openSync(path.join(output, file + '.log'), 'w')
    const started = Date.now()
    const result = spawnSync(runtime, args, { cwd: repo, env: { ...process.env, COLLAB_V2_TRACE: '0' },
      timeout: 180000, stdio: ['ignore', fd, fd] })
    fs.closeSync(fd)
    results.push({ file, code: result.status, signal: result.signal, error: result.error && result.error.message,
      elapsedMs: Date.now() - started, runtime: 'Node20.20.2' })
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results.at(-1)))
  }
  if (results.some(result => result.code !== 0)) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
