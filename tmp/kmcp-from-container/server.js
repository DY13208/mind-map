'use strict';
const http = require('http');
const crypto = require('crypto');
const { verifyToken, extractBearer } = require('./auth/jwt');
const { writeAudit } = require('./audit/log');
const { canonicalList, canonicalRead } = require('./adapters/canonical');
const { docmostSearch, docmostGet } = require('./adapters/docmost');
const { openwikiSearch, openwikiRead, openwikiStatus } = require('./adapters/openwiki');

const PORT = Number(process.env.KNOWLEDGE_MCP_PORT || 18792);
const JWT_SECRET = process.env.KNOWLEDGE_MCP_JWT_SECRET || '';

const TOOLS = [
  { name: 'canonical_list', description: 'List Canonical docs in ACL-allowed rooms.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' } } } },
  { name: 'canonical_read', description: 'Read one Canonical doc (manifest + ACL gated).', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, path: { type: 'string' } }, required: ['roomId', 'path'] } },
  { name: 'docmost_search', description: 'Mapping-first Docmost search within ACL rooms.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, query: { type: 'string' } } } },
  { name: 'docmost_get', description: 'Get mapped Docmost page; not_created if slot empty.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, topicKey: { type: 'string' }, slot: { type: 'string' }, pageId: { type: 'string' } } } },
  { name: 'openwiki_search', description: 'Search room-scoped OpenWiki only.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, query: { type: 'string' } } } },
  { name: 'openwiki_read', description: 'Read room-scoped OpenWiki page.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, path: { type: 'string' } }, required: ['roomId', 'path'] } },
  { name: 'openwiki_status', description: 'OpenWiki generation status for allowed rooms.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' } } } },
];

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authUser(req) {
  if (!JWT_SECRET) {
    const e = new Error('server_misconfigured');
    e.code = 'server_misconfigured';
    throw e;
  }
  const token = extractBearer(req);
  if (!token) {
    const e = new Error('unauthorized');
    e.code = 'unauthorized';
    throw e;
  }
  const payload = verifyToken(token, {
    secret: JWT_SECRET,
    iss: process.env.KNOWLEDGE_MCP_JWT_ISS || 'openclaw-liangce',
    aud: process.env.KNOWLEDGE_MCP_JWT_AUD || 'knowledge-mcp',
  });
  return String(payload.sub);
}

async function callTool(userId, name, args) {
  switch (name) {
    case 'canonical_list': return canonicalList(userId, args || {});
    case 'canonical_read': return canonicalRead(userId, { roomId: args.roomId, path: args.path });
    case 'docmost_search': return docmostSearch(userId, args || {});
    case 'docmost_get': return docmostGet(userId, args || {});
    case 'openwiki_search': return openwikiSearch(userId, args || {});
    case 'openwiki_read': return openwikiRead(userId, { roomId: args.roomId, path: args.path });
    case 'openwiki_status': return openwikiStatus(userId, args || {});
    default: {
      const e = new Error('unknown_tool');
      e.code = 'unknown_tool';
      throw e;
    }
  }
}

async function handleRpc(req, rpc) {
  if (rpc.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mind-map-knowledge-mcp', version: '0.1.0' },
    };
  }
  if (rpc.method === 'notifications/initialized' || rpc.method === 'notifications/cancelled') return null;
  if (rpc.method === 'ping') return {};
  if (rpc.method === 'tools/list') return { tools: TOOLS };
  if (rpc.method === 'tools/call') {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    let userId = null;
    let status = 'ok';
    let resultCount = null;
    const toolName = rpc.params && rpc.params.name;
    const args = (rpc.params && rpc.params.arguments) || {};
    try {
      userId = authUser(req);
      const result = await callTool(userId, toolName, args);
      resultCount = Array.isArray(result) ? result.length : result ? 1 : 0;
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      status = err.code || 'error';
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.code || 'error', message: String(err.message || err) }) }],
        isError: true,
      };
    } finally {
      writeAudit({
        requestId,
        requesterUserId: userId,
        tool: toolName,
        roomId: args && args.roomId,
        source: String(toolName || '').split('_')[0] || null,
        resultCount,
        status,
        durationMs: Date.now() - started,
      });
    }
  }
  return { error: { code: -32601, message: 'Method not found: ' + rpc.method } };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    return sendJson(res, 200, { ok: true, service: 'mind-map-knowledge-mcp', jwtConfigured: Boolean(JWT_SECRET) });
  }
  if (req.url === '/mcp' || (req.url && req.url.startsWith('/mcp?'))) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('event: endpoint\ndata: /mcp\n\n');
      return;
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    try {
      const raw = await readBody(req);
      const rpc = raw ? JSON.parse(raw) : {};
      const result = await handleRpc(req, rpc);
      if (rpc.id === undefined || rpc.id === null) { res.writeHead(202); return res.end(); }
      if (result && result.error && !result.content) {
        return sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, error: result.error });
      }
      return sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result });
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }
  sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`[knowledge-mcp] listening on ${PORT}`));
