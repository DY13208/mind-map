const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { failure } = require('./core')

const run = promisify(execFile)
const maxBytes = 20 * 1024 * 1024
const uploadHint = '请在已授权的本机用企业微信或 wecom-cli 下载原文件，再用审批附件直传票据上传'

function isWecomDiskShare(value) {
  try {
    const url = new URL(value)
    return url.origin === 'https://drive.weixin.qq.com' && url.pathname === '/s' &&
      !url.username && !url.password && Boolean(url.searchParams.get('k'))
  } catch {
    return false
  }
}

function localDownloadRequired() {
  return failure('WECOM_DISK_LOCAL_DOWNLOAD_REQUIRED', `微盘分享链接需要企微授权下载。${uploadHint}`, 422)
}

async function downloadWecomDiskFile(url) {
  if (!isWecomDiskShare(url)) throw localDownloadRequired()
  const entry = process.env.WCPD_WECOM_CLI_PATH ||
    (process.platform === 'win32' && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@wecom', 'cli', 'bin', 'wecom.js')
      : 'wecom-cli')
  const isNodeEntry = /\.[cm]?js$/i.test(entry)
  const command = isNodeEntry ? process.execPath : entry
  const args = isNodeEntry ? [path.resolve(entry)] : []
  const tempRoot = await fs.realpath(os.tmpdir())
  const directory = await fs.mkdtemp(path.join(tempRoot, 'wcpd-approval-'))
  try {
    const { stdout } = await run(command, [...args, 'disk', 'files', 'download',
      '--json', JSON.stringify({ url }), '--output-dir', directory], {
      cwd: directory, timeout: 90000, maxBuffer: 64 * 1024, windowsHide: true
    })
    const result = JSON.parse(stdout)
    if (typeof result?.file_path !== 'string' || !result.file_path ||
        /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(result.content_type || ''))
      throw localDownloadRequired()
    const file = await fs.realpath(path.resolve(directory, result.file_path))
    if (path.dirname(file) !== directory) throw localDownloadRequired()
    const handle = await fs.open(file, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || !stat.size) throw localDownloadRequired()
      if (stat.size > maxBytes) throw failure('FILE_TOO_LARGE', '微盘文件超过审批附件 20 MiB 上限', 413)
      const buffer = await handle.readFile()
      if (buffer.length > maxBytes) throw failure('FILE_TOO_LARGE', '微盘文件超过审批附件 20 MiB 上限', 413)
      return { fileName: path.basename(file), mimeType: result.content_type, contentBase64: buffer.toString('base64') }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error.code === 'FILE_TOO_LARGE') throw error
    throw failure('WECOM_DISK_DOWNLOAD_FAILED',
      `微盘原文件下载失败，请检查本机 wecom-cli 安装、授权及该链接的下载权限。${uploadHint}`, 422)
  } finally {
    if (path.dirname(directory) === tempRoot)
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

module.exports = { isWecomDiskShare, localDownloadRequired, downloadWecomDiskFile }
