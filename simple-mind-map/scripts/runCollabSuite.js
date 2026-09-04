const { spawn } = require('child_process')
const path = require('path')

const suite = process.argv[2]
const ROOT = path.resolve(__dirname, '..')
const TIMEOUT_MS = Number(process.env.COLLAB_V2_SUITE_TIMEOUT_MS || 20000)

const suites = {
  freeze: [
    'test/collabV2.drain.test.js',
    'test/exportBackground.test.js',
    'test/collabV2.test.js',
    'test/collabV2.direct.test.js',
    'test/collabV2.features.test.js',
    'test/collabV2.productFix.test.js',
    'test/collabInsertCollect.test.js',
    'test/collabGeneralization.test.js',
    'test/collabMove.test.js',
    'test/collabTreeAuthority.test.js',
    'test/collabMapMetaStyle.test.js',
    'test/collabLayoutGhost.test.js',
    'test/collabNodeFeatures.test.js',
    'test/collabDeleteMatrix.test.js',
    'test/collabSpecialObjects.test.js',
    'test/collabPaste.test.js',
    'test/collabPasteUndo.test.js',
    'test/collabReliability.test.js',
    'test/collabRoomRecovery.test.js',
    'test/roomNodes.test.js'
  ],
  integration: [
    'test/collabV2.acl.integration.test.js',
    'test/collabV2.idb.integration.test.js',
    'test/collabV2.socket.integration.test.js',
    'test/collabV2.five.integration.test.js',
    'test/collabRestart.integration.test.js',
    'test/twoClientSync.integration.test.js'
  ],
  benchmark: ['test/collabV2.pg.bench.test.js'],
  soak: ['test/collabV2.soak.integration.test.js']
}

function run(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      cwd: ROOT,
      env: {
        ...process.env,
        TEST_HANG_TRACE: process.env.TEST_HANG_TRACE || '1'
      },
      stdio: 'inherit'
    })
    const timer = setTimeout(() => {
      // Terminate this test's process tree even if its JS timers are starved.
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
      reject(new Error(`TEST_HANG_TRACE suite timeout: ${file} exceeded ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${file} exited with code ${code}`))
    })
  })
}

async function main() {
  const files = suites[suite]
  if (!files) {
    throw new Error(`Unknown collaboration suite: ${suite}`)
  }
  for (const file of files) {
    console.log(`[collab-suite:${suite}] ${file}`)
    await run(file)
  }
  console.log(`[collab-suite:${suite}] ok`)
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
