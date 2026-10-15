'use strict'
// This launcher checks ownership before any legacy script can import storage.
// Credentials stay in the ignored config and the child's environment.
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const { withIsolatedPg } = require('./isolation.cjs')
const repo = path.resolve(__dirname, '../..')
async function main() {
  let requested = process.argv.slice(2)
  if (requested[0] === '--suite') {
    const name = requested[1]
    if (!['test:collab:v2', 'test:collab:history', 'test:collab:files'].includes(name) || requested.length !== 2) {
      throw new Error('Choose a reviewed package suite')
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'simple-mind-map/package.json'), 'utf8'))
    requested = pkg.scripts[name].split(/\s*&&\s*/).map(command => {
      const match = /^node \.\/test\/([\w.-]+\.js)$/.exec(command)
      if (!match) throw new Error('Unsupported test command in reviewed suite')
      return 'simple-mind-map/test/' + match[1]
    })
  }
  if (!requested.length) throw new Error('Choose explicit repository test entry files')
  const files = requested.map(file => {
    const resolved = path.resolve(repo, file)
    if (!/^(simple-mind-map\/test|web\/tests|tests)\//.test(file) ||
      !resolved.startsWith(repo + path.sep) || !/\.(cjs|js)$/.test(resolved) || !fs.existsSync(resolved)) {
      throw new Error('Invalid isolated test entry: ' + file)
    }
    return { file, resolved }
  })
  await withIsolatedPg(async () => {})
  process.env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '')
  let failed = false
  for (const { file, resolved } of files) {
    console.log(JSON.stringify({ entry: file, runtime: process.version, stage: 'start' }))
    const result = spawnSync(process.execPath, [resolved], {
      cwd: repo, env: process.env, stdio: 'inherit', timeout: 180000
    })
    console.log(JSON.stringify({ entry: file, status: result.status, signal: result.signal || null,
      error: result.error ? result.error.message : null, stage: 'end' }))
    if (result.status !== 0) failed = true
  }
  if (failed) process.exitCode = 1
}
main().catch(error => { console.error(error.message); process.exitCode = 2 })
