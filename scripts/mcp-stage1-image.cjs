'use strict'

// Freeze a curated source context, build it, and bind runtime files/assets to
// their hashes. Only creates run-owned output and an image; never deploys it.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')
let stageReport = null
let stageReportPath = null
let phaseLogPath = null
let buildLogPath = null
let activePhase = 'argument-validation'
const [role, ...argv] = process.argv.slice(2)
const args = {}
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith('--') || !argv[i + 1]) throw new Error('Expected --name value')
  args[argv[i].slice(2)] = argv[i + 1]
}
const verifyOnly = args['verify-only'] === 'true'
if (!['baseline', 'candidate'].includes(role) || !args.output || (!verifyOnly && !args.tag)) {
  throw new Error('Usage: node scripts/mcp-stage1-image.cjs baseline|candidate --output output/run --tag image:tag [--ref commit], or add --verify-only true')
}
if (verifyOnly && role !== 'candidate') throw new Error('--verify-only is only supported for candidate outputs')
const output = path.resolve(root, args.output)
const outputRoot = path.join(root, 'output')
const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
const realRoot = fs.realpathSync(root)
const realOutputRoot = fs.realpathSync(outputRoot)
if (!isWithin(realRoot, realOutputRoot)) throw new Error('Repository output/ resolves outside the repository')
if (!isWithin(outputRoot, output)) throw new Error('Output must be a child of repository output/')
let existingAncestor = output
while (!fs.existsSync(existingAncestor)) {
  const parent = path.dirname(existingAncestor)
  if (parent === existingAncestor) throw new Error('Output has no existing parent')
  existingAncestor = parent
}
const realAncestor = fs.realpathSync(existingAncestor)
if (!isWithin(realOutputRoot, realAncestor) && realAncestor !== realOutputRoot) {
  throw new Error('Existing output ancestor resolves outside repository output/')
}
const resolvedTarget = path.resolve(realAncestor, path.relative(existingAncestor, output))
if (!isWithin(realOutputRoot, resolvedTarget)) throw new Error('Resolved output escapes repository output/')
if (verifyOnly) {
  if (!fs.existsSync(output) || !fs.statSync(output).isDirectory()) throw new Error('Verification output does not exist: ' + output)
  const realOutput = fs.realpathSync(output)
  if (!isWithin(realOutputRoot, realOutput)) throw new Error('Verification output resolves outside repository output/')
  if (fs.existsSync(path.join(output, 'source-binding-proof.json'))) {
    throw new Error('Refusing to overwrite existing source-binding-proof.json')
  }
} else if (fs.existsSync(output)) {
  throw new Error('Refusing to overwrite existing output: ' + output)
}
const run = (cmd, list, options = {}) => execFileSync(cmd, list, {
  cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true, ...options
})
const git = list => run('git', list).trim()
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase()
const hash = file => sha(fs.readFileSync(file))
const baseCommit = git(['rev-parse', role === 'baseline' ? (args.ref || 'origin/main') : 'HEAD'])
if (!verifyOnly) {
  const existingTags = run('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])
    .split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  if (existingTags.includes(args.tag)) throw new Error('Refusing to overwrite existing image tag: ' + args.tag)
}
const context = path.join(output, 'context')
function persistStageReport() {
  if (stageReport && stageReportPath) {
    fs.writeFileSync(stageReportPath, JSON.stringify(stageReport, null, 2))
  }
}
function reportPhase(phase, status, details = {}) {
  activePhase = phase
  if (!stageReport) return
  const entry = { at: new Date().toISOString(), phase, status, ...details }
  stageReport.activePhase = phase
  stageReport.phases.push(entry)
  if (phaseLogPath) fs.appendFileSync(phaseLogPath, JSON.stringify(entry) + '\n')
  persistStageReport()
  console.log('[stage] ' + JSON.stringify(entry))
}
function tailFile(file, maxBytes = 128 * 1024) {
  if (!file || !fs.existsSync(file)) return ''
  const size = fs.statSync(file).size
  const length = Math.min(size, maxBytes)
  const buffer = Buffer.alloc(length)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buffer, 0, length, size - length)
  } finally {
    fs.closeSync(fd)
  }
  return buffer.toString('utf8').split(/\r?\n/).slice(-100).join('\n')
}
const excluded = new Set(['.git', 'node_modules', 'output', 'dist', 'dist-build', 'dist-docker',
  'dist-docker-inject', 'dist-docker-tmp', 'coverage', '.cache', '.npm', '.secrets', 'data'])
const allowed = file => {
  if (file !== 'Dockerfile' && file !== '.dockerignore' && !/^(docker|web|simple-mind-map)\//.test(file)) return false
  return !file.split('/').some(segment => excluded.has(segment) || segment.startsWith('.env') || segment === '.mcp.json')
}
const roots = ['Dockerfile', '.dockerignore', 'docker', 'web', 'simple-mind-map']
const imagePath = file => {
  if (file.startsWith('simple-mind-map/') || file === 'web/package.json' || file.startsWith('web/scripts/')) return '/app/' + file
  return ({ 'docker/runtime-config.js': '/usr/share/nginx/html/runtime-config.js',
    'docker/nginx.conf': '/etc/nginx/nginx.conf.template', 'docker/start.sh': '/app/start.sh' })[file] || null
}
function walk(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const relative = prefix ? prefix + '/' + item.name : item.name
    if (item.isDirectory()) return walk(path.join(directory, item.name), relative)
    if (!item.isFile()) throw new Error('Unexpected special file: ' + relative)
    return [relative]
  })
}
function listCandidateFiles() {
  return [...new Set(run('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots
  ]).split('\0').filter(Boolean).filter(allowed))].sort()
}
function hashSnapshot(directory, files) {
  return files.map(file => {
    const absolute = path.join(directory, file)
    if (!fs.lstatSync(absolute).isFile()) throw new Error('Not a regular file: ' + file)
    return { path: file, hash: hash(absolute) }
  })
}
function digestSnapshot(snapshot) {
  return sha(snapshot.map(entry => entry.path + '\0' + entry.hash + '\n').join(''))
}
function verifyExistingCandidate() {
  const manifestFile = path.join(output, 'source-manifest.json')
  const imageFile = path.join(output, 'image.json')
  if (!fs.existsSync(manifestFile) || !fs.existsSync(imageFile)) {
    throw new Error('Candidate output is missing source-manifest.json or image.json')
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const image = JSON.parse(fs.readFileSync(imageFile, 'utf8'))
  if (manifest.role !== 'candidate' || image.role !== 'candidate') {
    throw new Error('Verification output does not contain a candidate image')
  }
  if (args.tag && image.imageTag !== args.tag) throw new Error('Candidate image tag does not match --tag')
  const currentHead = git(['rev-parse', 'HEAD'])
  const currentFiles = listCandidateFiles()
  const currentSnapshot = hashSnapshot(root, currentFiles)
  const expectedSnapshot = manifest.files.map(({ path: file, hash: fileHash }) => ({ path: file, hash: fileHash }))
  const manifestDigest = digestSnapshot(expectedSnapshot)
  const currentDigest = digestSnapshot(currentSnapshot)
  const manifestHash = hash(manifestFile)
  const assetsPath = path.join(output, 'web-assets')
  const expectedAssets = (manifest.runtimeAssets || []).map(asset => ({
    path: asset.imagePath.replace(/^\/usr\/share\/nginx\/html\//, ''),
    hash: asset.hash
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const currentAssets = fs.existsSync(assetsPath)
    ? hashSnapshot(assetsPath, walk(assetsPath).sort())
    : []
  const pathsAndHashesMatch = JSON.stringify(currentSnapshot) === JSON.stringify(expectedSnapshot)
  const proof = {
    generatedAt: new Date().toISOString(),
    baseCommit: manifest.baseCommit,
    currentHead,
    headMatches: currentHead === manifest.baseCommit,
    imageTag: image.imageTag,
    imageId: image.imageId,
    sourceManifest: manifestFile,
    sourceManifestSha256: manifestHash,
    imageRecordedManifestSha256: image.sourceManifestSha256,
    manifestHashMatchesImage: manifestHash === image.sourceManifestSha256,
    expectedFiles: expectedSnapshot.length,
    currentFiles: currentSnapshot.length,
    expectedSourceDigest: manifest.sourceDigest,
    sourceManifestDigestRecomputed: manifestDigest,
    currentSourceDigest: currentDigest,
    manifestDigestMatches: manifestDigest === manifest.sourceDigest,
    sourcePathsAndHashesMatch: pathsAndHashesMatch,
    workingTreeDiffSha256Scope: manifest.workingTreeDiffSha256
      ? 'tracked diffs under packaged roots only; untracked files are covered by files and sourceDigest'
      : null,
    untrackedFilesCoveredBy: 'source-manifest.json files and sourceDigest',
    expectedAssets: expectedAssets.length,
    currentAssets: currentAssets.length,
    runtimeAssetsMatch: JSON.stringify(currentAssets) === JSON.stringify(expectedAssets),
    directCopiesVerified: image.directCopiesVerified,
    status: null
  }
  proof.status = proof.headMatches && proof.manifestHashMatchesImage &&
    proof.manifestDigestMatches && proof.sourcePathsAndHashesMatch && proof.runtimeAssetsMatch
    ? 'matched'
    : 'mismatch'
  const proofPath = path.join(output, 'source-binding-proof.json')
  if (fs.existsSync(proofPath)) throw new Error('Refusing to overwrite existing source-binding-proof.json')
  fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2))
  console.log(JSON.stringify({ phase: 'source-binding-proof', proofPath, ...proof }, null, 2))
  if (proof.status !== 'matched') throw new Error('Candidate source binding did not match the frozen image manifest')
}
async function main() {
  if (verifyOnly) return verifyExistingCandidate()
  fs.mkdirSync(context, { recursive: true })
  stageReportPath = path.join(output, 'stage-report.json')
  phaseLogPath = path.join(output, 'stages.jsonl')
  buildLogPath = path.join(output, 'build.log')
  stageReport = {
    role,
    baseCommit,
    imageTag: args.tag,
    output,
    status: 'running',
    activePhase: 'source-freeze',
    phaseLog: phaseLogPath,
    buildLog: buildLogPath,
    phases: []
  }
  fs.writeFileSync(phaseLogPath, '')
  persistStageReport()
  reportPhase('source-freeze', 'started', { sourceMode: role === 'baseline' ? 'git-archive' : 'working-tree' })
  let source = root
  let files
  let headBeforeFreeze = null
  if (role === 'baseline') {
    source = path.join(output, 'archive-source')
    fs.mkdirSync(source)
    const archive = path.join(output, 'source.tar')
    fs.writeFileSync(archive, run('git', ['archive', '--format=tar', baseCommit, ...roots], { encoding: 'buffer' }))
    const extractPython = [
      'import sys, tarfile',
      'archive, destination = sys.argv[1], sys.argv[2]',
      'with tarfile.open(archive, "r:") as source:',
      '    source.extractall(destination, filter="data")'
    ].join('\n')
    run('python', ['-c', extractPython, archive, source])
    files = walk(source).filter(allowed)
  } else {
    headBeforeFreeze = git(['rev-parse', 'HEAD'])
    files = listCandidateFiles()
  }
  files = [...new Set(files)].sort()
  if (!files.includes('Dockerfile')) throw new Error('Missing Dockerfile')
  const sourceSnapshotBefore = hashSnapshot(source, files)
  const entries = files.map(file => {
    const src = path.join(source, file), dest = path.join(context, file)
    if (!fs.lstatSync(src).isFile()) throw new Error('Not a regular file: ' + file)
    const before = hash(src)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    if (hash(dest) !== before || hash(src) !== before) throw new Error('Source changed during freeze: ' + file)
    return { path: file, hash: before, imagePath: imagePath(file) }
  })
  const headAfterFreeze = role === 'candidate' ? git(['rev-parse', 'HEAD']) : null
  const filesAfterFreeze = role === 'candidate'
    ? listCandidateFiles()
    : [...new Set(walk(source).filter(allowed))].sort()
  const sourceSnapshotAfter = hashSnapshot(source, filesAfterFreeze)
  const freezeConsistent =
    JSON.stringify(sourceSnapshotBefore) === JSON.stringify(sourceSnapshotAfter) &&
    JSON.stringify(sourceSnapshotBefore) === JSON.stringify(entries.map(({ path: file, hash: fileHash }) => ({ path: file, hash: fileHash }))) &&
    (role !== 'candidate' || (headBeforeFreeze === headAfterFreeze && headBeforeFreeze === baseCommit))
  if (!freezeConsistent) throw new Error('Source paths, hashes, or HEAD changed during freeze')
  const manifest = { role, baseCommit, generatedAt: new Date().toISOString(), fileCount: entries.length,
    sourceDigest: digestSnapshot(sourceSnapshotBefore),
    workingTreeDiffSha256: role === 'candidate'
      ? sha(run('git', ['diff', '--binary', 'HEAD', '--', 'Dockerfile', '.dockerignore', 'docker', 'web', 'simple-mind-map']))
      : null,
    workingTreeDiffScope: role === 'candidate'
      ? 'tracked diffs under packaged roots only; untracked files are covered by files and sourceDigest'
      : null,
    freezeCheck: {
      headBefore: headBeforeFreeze,
      headAfter: headAfterFreeze,
      fileCountBefore: sourceSnapshotBefore.length,
      fileCountAfter: sourceSnapshotAfter.length,
      sourceDigestBefore: digestSnapshot(sourceSnapshotBefore),
      sourceDigestAfter: digestSnapshot(sourceSnapshotAfter),
      pathsHashesAndHeadMatch: freezeConsistent
    },
    files: entries, runtimeAssets: null }
  const manifestFile = path.join(output, 'source-manifest.json')
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  reportPhase('source-freeze', 'complete', {
    files: entries.length,
    sourceDigest: manifest.sourceDigest,
    sourceManifest: manifestFile,
    excludedSegments: [...excluded, '.env*', '.mcp.json']
  })
  console.log(JSON.stringify({ phase: 'frozen', role, baseCommit, files: entries.length, output }))
  const buildArgs = ['build', '--progress', 'plain']
  if (args.cache) buildArgs.push('--cache-from', args.cache)
  buildArgs.push('-t', args.tag, context)
  reportPhase('docker-build', 'started', {
    imageTag: args.tag,
    cacheFrom: args.cache || null,
    log: buildLogPath
  })
  const log = fs.createWriteStream(buildLogPath)
  log.write(`role=${role}\nbaseCommit=${baseCommit}\nimageTag=${args.tag}\ncontext=${context}\n`)
  await new Promise((resolve, reject) => {
    const child = spawn('docker', buildArgs,
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let buildTimedOut = false
    const timer = setTimeout(() => {
      buildTimedOut = true
      log.write('\nImage build timed out; waiting for Docker process to close.\n')
      child.kill()
    }, 20 * 60 * 1000)
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
    child.on('error', error => { clearTimeout(timer); log.end(() => reject(error)) })
    child.on('close', code => {
      clearTimeout(timer)
      log.end(() => {
        if (buildTimedOut) reject(new Error('Image build timed out; inspect build.log'))
        else if (code === 0) resolve()
        else reject(new Error('Build exited ' + code))
      })
    })
  })
  reportPhase('docker-build', 'complete', { imageTag: args.tag, log: buildLogPath })
  const direct = entries.filter(e => e.imagePath)
  reportPhase('runtime-source-verification', 'started', { files: direct.length })
  const digestScript = "const fs=require('fs'),c=require('crypto');const rows=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(rows.map(e=>({path:e.path,hash:c.createHash('sha256').update(fs.readFileSync(e.imagePath)).digest('hex').toUpperCase()}))))"
  const actual = JSON.parse(run('docker', ['run', '--rm', '-i', '--network', 'none', '--entrypoint', 'node', args.tag, '-e', digestScript], { input: JSON.stringify(direct) }))
  if (actual.some((entry, i) => entry.hash !== direct[i].hash)) throw new Error('Runtime source does not match frozen context')
  reportPhase('runtime-source-verification', 'complete', { files: direct.length, matched: true })
  reportPhase('image-inspection', 'started')
  const imageId = run('docker', ['image', 'inspect', '--format', '{{.Id}}', args.tag]).trim()
  reportPhase('image-inspection', 'complete', { imageId })
  reportPhase('static-asset-extraction', 'started')
  const container = run('docker', ['create', '--network', 'none', '--label', 'org.codex.mcp-stage1=extract', args.tag]).trim()
  const assets = path.join(output, 'web-assets')
  fs.mkdirSync(assets)
  try { run('docker', ['cp', container + ':/usr/share/nginx/html/.', assets]) }
  finally { run('docker', ['rm', container]) }
  manifest.runtimeAssets = walk(assets).sort().map(file => ({ imagePath: '/usr/share/nginx/html/' + file, hash: hash(path.join(assets, file)) }))
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  const result = { role, baseCommit, imageTag: args.tag, imageId, sourceDigest: manifest.sourceDigest,
    directCopiesVerified: direct.length, assets: manifest.runtimeAssets.length, sourceManifestSha256: hash(manifestFile),
    sourceManifest: manifestFile, buildDir: assets }
  fs.writeFileSync(path.join(output, 'image.json'), JSON.stringify(result, null, 2))
  if (role === 'candidate') verifyExistingCandidate()
  stageReport.status = 'ready'
  stageReport.image = result
  reportPhase('static-asset-extraction', 'complete', { assets: manifest.runtimeAssets.length, assetDirectory: assets })
  reportPhase('ready', 'complete', { imageTag: args.tag, imageId, sourceManifest: manifestFile, assetDirectory: assets })
  console.log(JSON.stringify({ phase: 'ready', ...result }, null, 2))
}
main().catch(error => {
  if (stageReport) {
    const failureReportPath = path.join(output, 'failure-report.json')
    stageReport.status = 'failed'
    stageReport.error = { name: error.name || 'Error', message: error.message || String(error) }
    stageReport.failureReport = failureReportPath
    if (buildLogPath && fs.existsSync(buildLogPath)) stageReport.buildLogTail = tailFile(buildLogPath)
    const entry = {
      at: new Date().toISOString(),
      phase: activePhase,
      status: 'failed',
      error: stageReport.error,
      buildLog: buildLogPath,
      failureReport: failureReportPath
    }
    stageReport.phases.push(entry)
    if (phaseLogPath) fs.appendFileSync(phaseLogPath, JSON.stringify(entry) + '\n')
    fs.writeFileSync(failureReportPath, JSON.stringify({
      role,
      baseCommit,
      imageTag: args.tag,
      output,
      phase: activePhase,
      error: stageReport.error,
      buildLog: buildLogPath,
      buildLogTail: stageReport.buildLogTail || ''
    }, null, 2))
    persistStageReport()
    console.error(JSON.stringify({
      phase: activePhase,
      error: stageReport.error,
      failureReport: failureReportPath,
      buildLog: buildLogPath
    }, null, 2))
  } else {
    console.error(error)
  }
  process.exitCode = 1
})
