const { issueIdentity, verifyIdentity } = require('./access')

async function handleApi(req, res, pathname) {
  if (!pathname.startsWith('/api/wiki-compiler/')) return false
  const send = (status, error) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ error }))
  }
  try {
    let userId
    if (req.headers['x-wiki-compiler-identity']) userId = verifyIdentity(req.headers['x-wiki-compiler-identity'])
    else {
      if (!await require('../auth').requireAuthenticatedRequest(req, res)) return true
      if (!req.authUser?.id || req.authUser.service) { send(401, 'unauthorized'); return true }
      userId = req.authUser.id
    }
    const suffix = pathname.slice('/api/wiki-compiler/'.length)
    if (!/^api\/(?:graph|search|topic\/[^/]+|concept\/[^/]+)$/.test(suffix)) { send(404, 'not_found'); return true }
    if (!['GET', 'POST'].includes(req.method)) { send(405, 'method_not_allowed'); return true }
    const base = new URL(process.env.WIKI_COMPILER_INTERNAL_URL || 'http://wiki-graph:3848/')
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('invalid upstream')
    let raw
    if (req.method === 'POST') {
      const chunks = []; let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 65536) { send(413, 'request_too_large'); return true }
        chunks.push(chunk)
      }
      raw = Buffer.concat(chunks)
    }
    const upstream = await fetch(new URL(suffix, base), {
      method: req.method,
      headers: { 'X-Wiki-Compiler-Identity': issueIdentity(userId), 'Content-Type': 'application/json' },
      body: raw, signal: AbortSignal.timeout(10000), redirect: 'error'
    })
    res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    for await (const chunk of upstream.body) res.write(chunk)
    res.end()
  } catch (error) {
    if (!res.headersSent) send(error.code === 'unauthorized' ? 401 : 503, error.code === 'unauthorized' ? 'unauthorized' : 'wiki_compiler_unavailable')
    else res.destroy()
  }
  return true
}
module.exports = { handleApi }
