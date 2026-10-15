const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const repo = path.resolve(__dirname, '../..')
const production = ['simple-mind-map/bin', 'simple-mind-map/src', 'simple-mind-map/index.js', 'web/src',
  'simple-mind-map/package.json', 'simple-mind-map/package-lock.json', 'web/package.json', 'web/package-lock.json']
const excluded = new Set(['node_modules', 'data', 'test', 'tests', 'reports', 'dist', '.git', '.codegraph'])
function capture(phase, output) {
  if (!['before', 'after'].includes(phase)) throw new Error('Invalid source manifest phase')
  const source = phase === 'before' ? path.join(repo, 'work/performance-tdd/baseline-source') : repo
  const files = []
  const visit = relative => {
    const full = path.join(source, relative)
    if (!fs.existsSync(full)) return
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(full).sort()) if (!excluded.has(child) && !child.startsWith('.env')) visit(path.join(relative, child))
    } else if (stat.isFile() && /\.(?:js|mjs|cjs|vue|json|sql|css|scss|html)$/.test(relative)) {
      const bytes = fs.readFileSync(full)
      files.push({ file: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  production.forEach(visit)
  const artifact = path.join(repo, 'work/performance-tdd', phase === 'before' ? 'baseline-web' : 'after-web')
  const js = path.join(artifact, 'js')
  const assets = fs.readdirSync(js).filter(name => name.endsWith('.js')).sort().map(name => ({ name,
    sha256: createHash('sha256').update(fs.readFileSync(path.join(js, name))).digest('hex') }))
  let diff = null, head = 'd5793106098afe8a2ff9bbb60193bc25e5e45f88'
  if (phase === 'after') {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    const patch = execFileSync('git', ['diff', '--no-ext-diff', '--', ...production], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    const patchPath = path.join(output, 'production-source.diff')
    fs.writeFileSync(patchPath, patch)
    diff = { path: patchPath, bytes: Buffer.byteLength(patch), sha256: createHash('sha256').update(patch).digest('hex'),
      boundary: 'Tracked production diff against current Git HEAD; the source file hashes also identify new untracked production modules. No .env, ignored runtime data or test evidence included.' }
  }
  const result = { capturedAt: Date.now(), phase, source, head, files, webpackAssets: assets, diff,
    identityBoundary: phase === 'before' ? 'Frozen original Git archive source and frozen original webpack assets; no candidate source diff is attributed to this baseline' :
      'Actual candidate source hashes/production diff and current webpack asset filenames plus SHA256. These configured asset filenames need not contain a contenthash; a compilation hash is only supported by its separately recorded successful Node20 build log. The source and artifact are not a newly committed revision.' }
  fs.writeFileSync(path.join(output, 'production-source-manifest.json'), JSON.stringify(result, null, 2))
  return result
}
module.exports = { capture }
