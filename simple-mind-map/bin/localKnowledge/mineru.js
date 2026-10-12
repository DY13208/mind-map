const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const dns = require('node:dns/promises')
const net = require('node:net')
const JSZip = require('jszip')
const fail = (code, message) => Object.assign(new Error(message), { code })
const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail('ABORT_ERR', '已取消'))
    const abort = () => {
      clearTimeout(timer)
      reject(fail('ABORT_ERR', '已取消'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
const MODEL = 'vlm',
  MAX_ZIP = 64 * 1024 * 1024,
  MAX_OUTPUT = 128 * 1024 * 1024
const { formatFor, extractionKey } = require('./formats')
function privateAddress(ip) {
  if (net.isIPv4(ip))
    return (
      /^(0|10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(ip) ||
      Number(ip.split('.')[0]) >= 224
    )
  return (
    ip === '::1' ||
    ip === '::' ||
    /^f[cd]|^fe[89ab]/i.test(ip) ||
    ip.startsWith('::ffff:')
  )
}
async function verifyPublicUrl(value) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  )
    throw fail('MINERU_INVALID_RESULT', '解析服务返回无效地址')
  const addresses = await dns.lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some(a => privateAddress(a.address)))
    throw fail('MINERU_INVALID_RESULT', '解析服务返回非公网地址')
}
async function limitedBody(response, max) {
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > max) throw fail('MINERU_INVALID_RESULT', '解析结果过大')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
async function unzipText(entry, budget) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const stream = entry.internalStream('nodebuffer')
    stream
      .on('data', chunk => {
        budget.bytes += chunk.length
        if (budget.bytes > MAX_OUTPUT) {
          stream.pause()
          reject(fail('MINERU_INVALID_RESULT', '解压结果过大'))
        } else chunks.push(chunk)
      })
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .resume()
  })
}
function tableText(html) {
  return String(html || '')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<\/(tr|p)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
async function parseArchive(buffer) {
  if (buffer.length > MAX_ZIP)
    throw fail('MINERU_INVALID_RESULT', '压缩结果过大')
  const zip = await JSZip.loadAsync(buffer),
    entries = Object.values(zip.files),
    budget = { bytes: 0 }
  if (entries.length > 4000)
    throw fail('MINERU_INVALID_RESULT', '结果文件数量过多')
  for (const entry of entries) {
    const name = entry.unsafeOriginalName || entry.name
    if (
      name.includes('\\') ||
      name.startsWith('/') ||
      /^[a-z]:/i.test(name) ||
      name.split('/').includes('..')
    )
      throw fail('MINERU_INVALID_RESULT', '无效压缩包路径')
    if (entry._data?.uncompressedSize > MAX_OUTPUT)
      throw fail('MINERU_INVALID_RESULT', '解压结果过大')
  }
  const content = entries.find(e => /_content_list\.json$/.test(e.name))
  let pages = []
  if (content) {
    const items = JSON.parse(await unzipText(content, budget))
    if (!Array.isArray(items))
      throw fail('MINERU_INVALID_RESULT', '内容列表格式错误')
    const groups = new Map(), blocks = new Map()
    for (const item of items) {
      const text =
        item.type === 'table'
          ? tableText(item.table_body || item.html)
          : item.type === 'list'
          ? (item.list_items || [])
              .map(v => (typeof v === 'string' ? v : v.text || ''))
              .join('\n')
          : String(item.text || '')
      if (!text.trim()) continue
      const page =
        Number.isInteger(item.page_idx) && item.page_idx >= 0
          ? item.page_idx + 1
          : null
      if (!groups.has(page)) groups.set(page, [])
      groups.get(page).push(text)
      if (!blocks.has(page)) blocks.set(page,[])
      blocks.get(page).push({type:item.type || 'text',text,bbox:item.bbox || null,tableHtml:item.type === 'table' ? item.table_body || item.html || '' : undefined})
    }
    pages = [...groups].map(([page, lines]) => ({
      page,
      pageMissing: page === null,
      text: lines.join('\n'),
      blocks: blocks.get(page) || [],
      method: 'mineru'
    }))
  }
  if (!pages.length) {
    const md =
      entries.find(e => /(^|\/)full\.md$/.test(e.name)) ||
      entries.find(e => /\.md$/.test(e.name))
    if (md)
      pages = [
        {
          page: null,
          pageMissing: true,
          text: await unzipText(md, budget),
          method: 'mineru'
        }
      ]
  }
  if (!pages.some(p => p.text.trim()))
    throw fail('MINERU_EMPTY_RESULT', 'MinerU 返回空正文，资料尚未读取')
  return pages
}
function createMineru({
  token = process.env.MINERU_API_TOKEN || '',
  fetch = globalThis.fetch,
  cacheDir = process.env.LOCAL_KNOWLEDGE_CACHE_DIR ||
    path.resolve('data/local-knowledge-cache'),
  pollMs = 3000,
  authRetryMs = 60000,
  timeout = 1200000,
  verifyUrl = verifyPublicUrl
} = {}) {
  const inflight = new Map()
  let authBlocked = false,
    authRetryAt = 0,
    authProbe
  function blockAuth() {
    authBlocked = true
    authRetryAt = Date.now() + authRetryMs
  }
  async function recoverAuth() {
    if (!authBlocked) return
    if (authProbe) return authProbe
    if (Date.now() < authRetryAt)
      throw fail('MINERU_AUTH_FAILED', 'MinerU 认证暂停，稍后自动验证')
    authRetryAt = Date.now() + authRetryMs
    authProbe = (async () => {
      try {
        const r = await fetch(
          'https://mineru.net/api/v4/extract-results/batch/00000000-0000-0000-0000-000000000000',
          {
            headers: { Authorization: 'Bearer ' + token },
            redirect: 'error',
            signal: AbortSignal.timeout(10000)
          }
        )
        const data = await r.json()
        if (r.ok && [0, -60012].includes(data.code)) {
          authBlocked = false
          return
        }
      } catch {}
      throw fail('MINERU_AUTH_FAILED', 'MinerU 认证暂停，稍后自动验证')
    })().finally(() => {
      authProbe = null
    })
    return authProbe
  }
  async function request(url, options = {}, api = false, signal) {
    if (!api) await verifyUrl(url)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: api
            ? {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + token
              }
            : options.headers,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)])
        })
        if (api && response.status === 401) {
          blockAuth()
          throw fail('MINERU_AUTH_FAILED', 'MinerU 认证失败，请检查 Token')
        }
        if (api && response.status === 403) {
          let data
          try {
            data = JSON.parse(
              (await limitedBody(response, 2 * 1024 * 1024)).toString()
            )
          } catch {}
          if (['A0202', 'A0211'].includes(data?.code)) {
            blockAuth()
            throw fail('MINERU_AUTH_FAILED', 'MinerU Token 错误或过期')
          }
          throw fail(
            'MINERU_ACCESS_DENIED',
            'MinerU 请求被拒绝，认证状态未确定为失败'
          )
        }
        if (response.status === 429 || response.status >= 500) {
          if (attempt < 2) {
            await response.body?.cancel()
            await pause(1000 * 2 ** attempt, signal)
            continue
          }
          throw fail(
            response.status === 429
              ? 'MINERU_RATE_LIMITED'
              : 'MINERU_NETWORK_ERROR',
            'MinerU 暂不可用或限流'
          )
        }
        if (
          !api &&
          options.method === 'PUT' &&
          [400, 401, 403, 404, 410].includes(response.status)
        )
          throw fail('MINERU_TASK_EXPIRED', 'MinerU 上传地址已失效')
        if (!response.ok)
          throw fail(
            api ? 'MINERU_PARSE_FAILED' : 'MINERU_NETWORK_ERROR',
            'MinerU 请求失败'
          )
        return response
      } catch (e) {
        if (e.code || signal.aborted) throw e
        if (attempt === 2)
          throw fail('MINERU_NETWORK_ERROR', 'MinerU 网络请求失败')
        await pause(1000 * 2 ** attempt, signal)
      }
    }
  }
  async function api(endpoint, body, signal) {
    const response = await request(
      'https://mineru.net/api/v4/' + endpoint,
      {
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined
      },
      true,
      signal
    )
    const data = JSON.parse(
      (await limitedBody(response, 2 * 1024 * 1024)).toString()
    )
    if (['A0202', 'A0211'].includes(data.code)) {
      blockAuth()
      throw fail('MINERU_AUTH_FAILED', 'MinerU Token 错误或过期')
    }
    if (data.code === -60013)
      throw fail('MINERU_ACCESS_DENIED', 'MinerU 无权访问该解析任务')
    if (data.code === -60002)
      throw fail('MINERU_FORMAT_REJECTED', 'MinerU 未接受该文件格式')
    if (data.code === -60012)
      throw fail('MINERU_TASK_EXPIRED', 'MinerU 任务已过期')
    if (data.code === -60018 || data.code === -60019)
      throw fail('MINERU_QUOTA_EXCEEDED', 'MinerU 额度已用完')
    if (data.code === -60015 || data.code === -60016)
      throw fail('MINERU_CONVERSION_FAILED', 'MinerU 文件转换失败')
    if (data.code === -60009)
      throw fail('MINERU_RATE_LIMITED', 'MinerU 任务队列已满')
    if (data.code !== 0)
      throw fail('MINERU_PARSE_FAILED', 'MinerU 未接受解析任务')
    return data.data
  }
  async function extract(file, { signal, onStatus } = {}) {
    const format = formatFor(file)
    if (format?.provider !== 'mineru')
      throw fail('unsupported', '官方在线 API 未支持该格式')
    if (!token) throw fail('MINERU_NOT_CONFIGURED', 'MinerU Token 未配置')
    if (authBlocked) await recoverAuth()
    const stat = await fs.stat(file)
    if (stat.size > 50 * 1024 * 1024) throw fail('too_large', '文件超过 50 MB')
    const buffer = await fs.readFile(file),
      hash = crypto
        .createHash('sha256')
        .update(buffer)
        .update(extractionKey(file))
        .update(/\.(docx?|pptx?|xlsx?|html)$/i.test(file) ? format.ext : '')
        .digest('hex'),
      dir = path.join(cacheDir, 'mineru-tasks'),
      stateFile = path.join(dir, hash + '.json')
    if (inflight.has(hash)) return inflight.get(hash)
    const job = (async () => {
      const deadline = AbortSignal.timeout(timeout),
        combined = signal ? AbortSignal.any([signal, deadline]) : deadline
      let state
      await fs.mkdir(dir, { recursive: true })
      try {
        state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
      } catch {}
      if (state?.pages) return state.pages
      const save = async () => {
        const tmp = stateFile + '.tmp'
        await fs.writeFile(tmp, JSON.stringify(state))
        await fs.rename(tmp, stateFile)
      }
      try {
        if (!state) {
          onStatus?.('正在申请 MinerU 上传任务…')
          const data = await api(
            'file-urls/batch',
            {
              files: [
                {
                  name: hash + path.extname(file).toLowerCase(),
                  data_id: hash,
                  ...(format.model === 'vlm' ? { is_ocr: true } : {})
                }
              ],
              model_version: format.model,
              language: 'ch',
              enable_table: true,
              enable_formula: false
            },
            combined
          )
          if (!data?.batch_id || !data.file_urls?.[0])
            throw fail('MINERU_INVALID_RESULT', 'MinerU 任务响应不完整')
          state = {
            batchId: data.batch_id,
            uploadUrl: data.file_urls[0],
            uploaded: false
          }
          await save()
        }
        if (!state.uploaded) {
          onStatus?.('正在上传资料到 MinerU…')
          await request(
            state.uploadUrl,
            { method: 'PUT', body: buffer },
            false,
            combined
          )
          state.uploaded = true
          delete state.uploadUrl
          await save()
        }
        while (true) {
          const data = await api(
              'extract-results/batch/' + encodeURIComponent(state.batchId),
              null,
              combined
            ),
            result = data?.extract_result?.[0]
          if (!result)
            throw fail('MINERU_INVALID_RESULT', 'MinerU 任务结果不完整')
          if (result.state === 'failed') {
            await fs.unlink(stateFile).catch(() => {})
            throw fail(
              /转换|convert/i.test(result.err_msg || '')
                ? 'MINERU_CONVERSION_FAILED'
                : 'MINERU_PARSE_FAILED',
              /转换|convert/i.test(result.err_msg || '')
                ? 'MinerU 文件转换失败'
                : 'MinerU 解析失败'
            )
          }
          if (result.state === 'done') {
            if (!result.full_zip_url)
              throw fail('MINERU_INVALID_RESULT', 'MinerU 缺少结果地址')
            onStatus?.('正在读取 MinerU 解析结果…')
            const response = await request(
              result.full_zip_url,
              {},
              false,
              combined
            )
            const pages = await parseArchive(
              await limitedBody(response, MAX_ZIP)
            )
            state = { batchId: state.batchId, uploaded: true, pages }
            await save()
            return pages
          }
          const progress = result.extract_progress
          onStatus?.(
            result.state === 'running'
              ? `MinerU 正在解析${
                  progress?.total_pages
                    ? '：' +
                      (progress.extracted_pages || 0) +
                      '/' +
                      progress.total_pages +
                      ' 页'
                    : ''
                }…`
              : 'MinerU 排队中…'
          )
          await pause(pollMs, combined)
        }
      } catch (e) {
        if (e.code === 'MINERU_TASK_EXPIRED') {
          await fs.unlink(stateFile).catch(() => {})
          throw fail(
            'MINERU_PARSE_FAILED',
            'MinerU 任务已过期，下次刷新将重新提交'
          )
        }
        if (deadline.aborted)
          throw fail('MINERU_TIMEOUT', 'MinerU 解析超时，任务可恢复')
        if (signal?.aborted)
          throw Object.assign(fail('ABORT_ERR', '已取消'), {
            name: 'AbortError'
          })
        throw e
      }
    })()
    inflight.set(hash, job)
    try {
      return await job
    } finally {
      inflight.delete(hash)
    }
  }
  return {
    extract,
    status: () => ({
      provider: 'mineru',
      configured: !!token,
      authBlocked,
      model: MODEL
    })
  }
}
module.exports = { createMineru, parseArchive, extractionKey }
