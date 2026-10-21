'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)
const ROOT = path.join(os.tmpdir(), 'file-kb-prepared')
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'bmp', 'webp'])

async function runPreparation(mode, source, destination, signal) {
  try {
    const { stdout } = await run(process.env.KB_PYTHON || '/opt/kb-python/bin/python',
      [path.join(__dirname, 'prepare.py'), mode, source, destination],
      { signal, timeout: 120000, maxBuffer: 64 * 1024, windowsHide: true })
    return JSON.parse(stdout)
  } catch (err) {
    if (signal?.aborted) throw signal.reason || err
    let message = err.killed ? '文件预处理超时（120 秒）' : '文件预处理失败：无法读取、文件损坏或已加密'
    try { message = JSON.parse(err.stderr).error || message } catch (_) {}
    const failure = new Error(message)
    failure.code = 'PREPROCESS_FAILED'
    failure.status = 422
    failure.retryable = false
    throw failure
  }
}

async function withPreparedInput(input, callback, { root = ROOT, runner = runPreparation } = {}) {
  input.signal?.throwIfAborted()
  const mode = IMAGE_EXTS.has(input.ext) ? 'image' : input.ext === 'xls' ? 'xls' : null
  if (!mode) return callback(input)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await fs.mkdtemp(path.join(root, 'job-'))
  try {
    const ext = mode === 'image' ? 'png' : 'xlsx'
    const filePath = path.join(directory, `input.${ext}`)
    const start = Date.now()
    const preprocessing = await runner(mode, input.filePath, filePath, input.signal)
    input.signal?.throwIfAborted()
    const fileName = path.basename(input.fileName, path.extname(input.fileName)) + '.' + ext
    return await callback({ ...input, filePath, fileName, ext, preprocessing: { ...preprocessing, ms: Date.now() - start } })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

// Storage keys have no extension. Detect BIFF's OLE header, never infer from the key.
async function withPreparedExcel(filePath, callback, { signal } = {}) {
  const file = await fs.open(filePath, 'r')
  const bytes = Buffer.alloc(8)
  try { await file.read(bytes, 0, bytes.length, 0) } finally { await file.close() }
  if (!bytes.equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return callback(filePath)
  return withPreparedInput({ filePath, fileName: 'workbook.xls', ext: 'xls', signal },
    async prepared => {
      const result = await callback(prepared.filePath)
      if (result && !Array.isArray(result)) result.preprocessing = prepared.preprocessing
      return result
    })
}

// Each service has a private container /tmp; call before accepting jobs or HTTP requests.
async function cleanupPrepared(root = ROOT) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  for (const name of await fs.readdir(root)) {
    if (name.startsWith('job-')) await fs.rm(path.join(root, name), { recursive: true, force: true })
  }
}
module.exports = { IMAGE_EXTS, withPreparedInput, withPreparedExcel, cleanupPrepared }
