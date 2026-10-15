const fs = require('node:fs')
const path = require('node:path')
const { repo } = require('./online-web-fixture.cjs')
const { run } = require('./online-browser-matrix.cjs')
async function main() {
  const phase = process.env.PERF_TDD_ONLINE_PHASE || 'before'
  const root = path.join(repo, 'work/performance-tdd', phase, 'online', 'ordinary-logical')
  fs.mkdirSync(root, { recursive: true })
  process.env.PERF_TDD_ONLINE_DIAGNOSTIC = '0'
  process.env.PERF_TDD_ONLINE_PEERS = '13'
  process.env.PERF_TDD_ONLINE_SAMPLES = '200'
  process.env.PERF_TDD_ONLINE_OPERATION_TIMEOUT = '300000'
  fs.writeFileSync(path.join(root, 'runner-process.json'), JSON.stringify({ pid: process.pid,
    phase, startedAt: Date.now(), commandsPerInstanceGroup: 200, contexts: 13,
    config: 'complete App ordinary logicalStructure compactLayout=false; single then double actual app instances' }, null, 2))
  for (const instances of [1, 2]) {
    process.env.PERF_TDD_ONLINE_INSTANCES = String(instances)
    await run()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
