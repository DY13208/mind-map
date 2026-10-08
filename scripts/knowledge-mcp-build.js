const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const CONTEXT = path.join(ROOT, 'integrations', 'knowledge-mcp')
const LABEL = 'mind-map.knowledge-mcp.runtime-sha'

function runtimeHash() {
  const hash = crypto.createHash('sha256')
  for (const file of ['Dockerfile', 'package.json', 'package-lock.json', 'docker-entrypoint.sh']) {
    hash.update(file + '\0')
    // Checkout line endings do not change the runtime inputs.
    hash.update(fs.readFileSync(path.join(CONTEXT, file), 'utf8').replace(/\r\n/g, '\n'))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function copySourceImage(imageTag, env) {
  const dir = path.join(ROOT, '.docker-build-stamps')
  fs.mkdirSync(dir, { recursive: true })
  const dockerfile = path.join(dir, 'knowledge-mcp.Dockerfile')
  fs.writeFileSync(dockerfile, `FROM ${imageTag}\nCOPY --chown=node:node src /app/src\nLABEL ${LABEL}="${runtimeHash()}"\n`)
  execFileSync('docker', ['build', '--pull=false', '-t', imageTag, '-f', dockerfile, CONTEXT], {
    cwd: ROOT, env, stdio: 'inherit', windowsHide: true
  })
}

function buildKnowledgeMcp(imageTag, extraEnv) {
  const env = { ...process.env, ...(extraEnv || {}) }
  let cachedHash
  try {
    const image = JSON.parse(execFileSync('docker', ['image', 'inspect', imageTag], {
      encoding: 'utf8', windowsHide: true
    }))[0]
    cachedHash = image.Config.Labels && image.Config.Labels[LABEL]
  } catch (_) {}
  if (cachedHash === runtimeHash()) {
    console.log('  knowledge-mcp runtime unchanged; updating source from local image')
  } else {
    execFileSync('docker', ['compose', '-f', 'docker-compose.yml', 'build', 'knowledge-mcp'], {
      cwd: ROOT, stdio: 'inherit', env, windowsHide: true
    })
  }
  // Record the runtime fingerprint only after a successful full build, or when
  // the installed image already has a matching fingerprint. Dependency/runtime
  // changes always require the regular Dockerfile build.
  copySourceImage(imageTag, env)
}

module.exports = { buildKnowledgeMcp, runtimeHash, copySourceImage }
