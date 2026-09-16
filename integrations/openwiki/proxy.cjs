const http = require('http')
const upstream = new URL(process.env.OPENWIKI_MIND_MAP_MCP_URL || 'http://app/mcp')
http.createServer((req, res) => {
  if (req.url !== '/mcp') { res.writeHead(404); res.end(); return }
  const forwarded = http.request(upstream, { method: req.method, headers: { ...req.headers, host: upstream.host } }, reply => {
    res.writeHead(reply.statusCode, reply.headers)
    reply.pipe(res)
  })
  forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('MCP upstream unavailable') })
  req.pipe(forwarded)
}).listen(3848, '127.0.0.1')
