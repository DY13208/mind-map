const fs = require('fs')
const path = require('path')
const { startStack, REPO_ROOT } = require('./server')
const { writeRuntime } = require('./helpers')

module.exports = async () => {
  const index = path.join(REPO_ROOT, 'index.html')
  const app = path.join(REPO_ROOT, 'dist/js/app.js')
  if (!fs.existsSync(index) || !fs.existsSync(app)) {
    throw new Error('E2E 需要仓库根目录 index.html 和 dist/js/app.js')
  }
  const buildInfoPath = path.join(REPO_ROOT, 'dist/build-info.json')
  let build = null
  if (fs.existsSync(buildInfoPath)) {
    build = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
  }
  const stack = await startStack({ auth: false, collabV2: 1 })
  writeRuntime({
    origin: stack.origin,
    api: stack.api,
    webPort: stack.webPort,
    collabPort: stack.collabPort,
    pid: stack.child.pid,
    build
  })
  global.__COLLAB_E2E_STACK__ = stack
}
