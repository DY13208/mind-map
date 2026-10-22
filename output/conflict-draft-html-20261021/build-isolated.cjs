const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync, spawn } = require('child_process')
const out = __dirname, repo = path.resolve(out, '../..'), source = path.join(out, 'source')
const dist = path.join(out, 'frontend-dist'), context = path.join(out, 'image-context')
const image = 'mind-map-app:conflict-draft-html-20261021'
const base = 'mind-map-app:collab-trace-quiet-20261021'
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const run = (cmd, args) => execFileSync(cmd, args, { cwd: repo, windowsHide: true, encoding: 'utf8', maxBuffer: 16000000 }).trim()
const files = JSON.parse(fs.readFileSync(path.join(out, 'fix-files.json')))
function walk(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(item => {
    const name = prefix ? prefix + '/' + item.name : item.name
    return item.isDirectory() ? walk(root, name) : [name]
  })
}
async function stream(cmd, args, cwd, logName, shell = false) {
  const log = fs.createWriteStream(path.join(out, logName))
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, shell, env: { ...process.env,
      NODE_OPTIONS: '--openssl-legacy-provider', NODE_ENV: 'production', PUBLIC_PATH: '/' } })
    child.stdout.on('data', data => log.write(data)); child.stderr.on('data', data => log.write(data))
    child.on('error', reject)
    child.on('close', code => log.end(() => code === 0 ? resolve() : reject(Error(logName + ' exit ' + code))))
  })
}
async function main() {
  for (const relative of files) {
    if (!relative.startsWith('web/') || relative.includes('..')) throw Error('Invalid fix path')
    const target = path.join(source, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(repo, relative), target)
  }
  for (const dir of ['web', 'simple-mind-map']) fs.symlinkSync(path.join(repo, dir, 'node_modules'), path.join(source, dir, 'node_modules'), 'junction')
  const changes = files.map(file => ({ path: file, sha256: sha(path.join(source, file)) }))
  fs.writeFileSync(path.join(out, 'source-overlay.json'), JSON.stringify({ head: run('git', ['rev-parse', 'HEAD']), changes }, null, 2))
  await stream(path.join(repo, 'web/node_modules/.bin/vue-cli-service.cmd'), ['build', '--dest', dist], path.join(source, 'web'), 'frontend-build.log', true)
  changes.forEach(row => { if (sha(path.join(source, row.path)) !== row.sha256) throw Error('Snapshot changed during build') })
  fs.mkdirSync(path.join(context, 'frontend-dist'), { recursive: true })
  const artifacts = walk(dist).filter(file => file !== 'runtime-config.js').map(file => {
    const target = path.join(context, 'frontend-dist', file)
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(dist, file), target)
    return { path: file, sha256: sha(target) }
  })
  fs.writeFileSync(path.join(context, 'Dockerfile'), `FROM ${base}\nCOPY frontend-dist/ /usr/share/nginx/html/\n`)
  await stream('docker', ['build', '--pull=false', '-t', image, context], repo, 'docker-build.log')
  const id = run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])
  fs.writeFileSync(path.join(out, 'build-result.json'), JSON.stringify({ passed: true, image, imageId: id,
    base, sourceHead: run('git', ['rev-parse', 'HEAD']), overlays: changes, artifacts,
    excludedUncommittedChanges: ['web/package.json', 'web/src/pages/ProductShell/FilesPage.vue',
      'web/src/pages/ProductShell/components/FileSearch.vue', 'web/src/pages/ProductShell/components/FolderCard.vue',
      'web/src/pages/ProductShell/components/RoomCard.vue', 'web/src/style/mobile.less'] }, null, 2))
  console.log(JSON.stringify({ passed: true, image, id, artifacts: artifacts.length, overlays: changes }))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
