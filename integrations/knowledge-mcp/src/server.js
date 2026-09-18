'use strict';
const http = require('http');
const crypto = require('crypto');
const { verifyToken, extractBearer } = require('./auth/jwt');
const { writeAudit } = require('./audit/log');
const { getPool } = require('./acl/rooms');
const { canonicalList, canonicalRead } = require('./adapters/canonical');
const { docmostSearch, docmostGet } = require('./adapters/docmost');
const { openwikiSearch, openwikiRead, openwikiStatus } = require('./adapters/openwiki');
const { docmostAiGet, docmostAiUpsert } = require('./adapters/docmostAi');
const {
  openwikiRefresh,
  openwikiRefreshStatus,
  openwikiRetryPublish,
} = require('./adapters/openwikiRefresh');
const { createRateLimiter, payloadLimits } = require('./security/rateLimit');
const { breakers } = require('./security/resilience');
const jobStore = require('./jobs/jobStore');

const PORT = Number(process.env.KNOWLEDGE_MCP_PORT || 18792);
const JWT_SECRET = process.env.KNOWLEDGE_MCP_JWT_SECRET || '';
const VERSION = '0.4.0';
const rateLimiter = createRateLimiter({
  windowMs: Number(process.env.KNOWLEDGE_MCP_RATE_WINDOW_MS || 60000),
  maxPerUser: Number(process.env.KNOWLEDGE_MCP_RATE_MAX_PER_USER || 60),
  maxRefreshPerRoomPerHour: Number(process.env.KNOWLEDGE_MCP_REFRESH_MAX_PER_ROOM_HOUR || 10),
});
const limits = payloadLimits(process.env);

const TOOLS = [
  { name: 'canonical_list', description: 'List Canonical docs in ACL-allowed rooms.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' } } } },
  { name: 'canonical_read', description: 'Read one Canonical doc (manifest + ACL gated).', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, path: { type: 'string' } }, required: ['roomId', 'path'] } },
  { name: 'docmost_search', description: 'Mapping-first Docmost search within ACL rooms.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, query: { type: 'string' } } } },
  { name: 'docmost_get', description: 'Get mapped Docmost page; not_created if slot empty.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, topicKey: { type: 'string' }, slot: { type: 'string' }, pageId: { type: 'string' } } } },
  { name: 'docmost_ai_get', description: 'Get AI-slot Docmost page for room+topic (server resolves mapping).', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, topicKey: { type: 'string' } }, required: ['roomId', 'topicKey'] } },
  { name: 'docmost_ai_upsert', description: 'Create/replace AI-slot Docmost page for room+topic only.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, topicKey: { type: 'string' }, content: { type: 'string' }, optionalTitle: { type: 'string' } }, required: ['roomId', 'topicKey', 'content'] } },
  { name: 'openwiki_search', description: 'Search room-scoped OpenWiki only.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, query: { type: 'string' } } } },
  { name: 'openwiki_read', description: 'Read room-scoped OpenWiki page.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, path: { type: 'string' } }, required: ['roomId', 'path'] } },
  { name: 'openwiki_status', description: 'OpenWiki generation status for allowed rooms.', inputSchema: { type: 'object', properties: { roomId: { type: 'string' } } } },
  { name: 'openwiki_refresh', description: 'Enqueue room-scoped OpenWiki refresh (editor+).', inputSchema: { type: 'object', properties: { roomId: { type: 'string' } }, required: ['roomId'] } },
  { name: 'openwiki_refresh_status', description: 'Get OpenWiki refresh job status.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, roomId: { type: 'string' } } } },
  { name: 'openwiki_retry_publish', description: 'Retry Docmost AI publish without regenerating OpenWiki.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] } },
];

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limits.maxBodyBytes) {
        const err = new Error('payload_too_large');
        err.code = 'payload_too_large';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
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

function validateArgs(name, args) {
  const a = args || {};
  if (a.query != null && String(a.query).length > limits.maxQueryLen) {
    const e = new Error('query_too_long');
    e.code = 'query_too_long';
    throw e;
  }
  if (name === 'docmost_ai_upsert' && a.content != null && String(a.content).length > limits.maxWriteChars) {
    const e = new Error('content_too_large');
    e.code = 'content_too_large';
    throw e;
  }
  if (a.roomId != null && !/^[A-Za-z0-9._:-]{1,128}$/.test(String(a.roomId))) {
    const e = new Error('invalid_room_id');
    e.code = 'invalid_room_id';
    throw e;
  }
}

async function callTool(userId, name, args) {
  validateArgs(name, args);
  const rl = rateLimiter.checkUser(userId);
  if (!rl.ok) {
    const e = new Error('rate_limited');
    e.code = 'rate_limited';
    throw e;
  }
  if (name === 'openwiki_refresh') {
    const rr = rateLimiter.checkRefresh(args && args.roomId);
    if (!rr.ok) {
      const e = new Error('refresh_rate_limited');
      e.code = 'refresh_rate_limited';
      throw e;
    }
  }
  switch (name) {
    case 'canonical_list': return canonicalList(userId, args || {});
    case 'canonical_read': return canonicalRead(userId, { roomId: args.roomId, path: args.path });
    case 'docmost_search': return docmostSearch(userId, args || {});
    case 'docmost_get': return docmostGet(userId, args || {});
    case 'docmost_ai_get': return docmostAiGet(userId, args || {});
    case 'docmost_ai_upsert': return docmostAiUpsert(userId, args || {});
    case 'openwiki_search': return openwikiSearch(userId, args || {});
    case 'openwiki_read': return openwikiRead(userId, { roomId: args.roomId, path: args.path });
    case 'openwiki_status': return openwikiStatus(userId, args || {});
    case 'openwiki_refresh': return openwikiRefresh(userId, args || {});
    case 'openwiki_refresh_status': return openwikiRefreshStatus(userId, args || {});
    case 'openwiki_retry_publish': return openwikiRetryPublish(userId, args || {});
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
      serverInfo: { name: 'mind-map-knowledge-mcp', version: VERSION },
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
    let auditExtra = {};
    const toolName = rpc.params && rpc.params.name;
    const args = (rpc.params && rpc.params.arguments) || {};
    try {
      userId = authUser(req);
      const result = await callTool(userId, toolName, args);
      resultCount = Array.isArray(result) ? result.length : result ? 1 : 0;
      if (result && result.audit) auditExtra = result.audit;
      if (result && result.jobId) auditExtra.jobId = result.jobId;
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
        topicKey: (args && args.topicKey) || auditExtra.topicKey || null,
        operation: auditExtra.operation || null,
        targetSlot: auditExtra.targetSlot || null,
        docmostPageId: auditExtra.docmostPageId || null,
        beforeHash: auditExtra.beforeHash || null,
        afterHash: auditExtra.afterHash || null,
        jobId: auditExtra.jobId || null,
        source: String(toolName || '').split('_')[0] || null,
        resultCount,
        status,
        durationMs: Date.now() - started,
      });
    }
  }
  return { error: { code: -32601, message: 'Method not found: ' + rpc.method } };
}

async function readiness() {
  const out = { ok: true, version: VERSION, checks: {} };
  try {
    await getPool().query('select 1 as ok');
    out.checks.aclDb = { ok: true };
  } catch (e) {
    out.ok = false;
    out.checks.aclDb = { ok: false, error: 'unavailable' };
  }
  try {
    await jobStore.ensureSchema();
    out.checks.jobStore = { ok: true };
  } catch (e) {
    out.ok = false;
    out.checks.jobStore = { ok: false, error: 'unavailable' };
  }
  out.circuits = {
    canonical: breakers.canonical.snapshot(),
    docmost: breakers.docmost.snapshot(),
    openwiki: breakers.openwiki.snapshot(),
    aclDb: breakers.aclDb.snapshot(),
  };
  out.limits = limits;
  out.replicasPolicy = process.env.KNOWLEDGE_MCP_REPLICAS_POLICY || 'single';
  return out;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'mind-map-knowledge-mcp',
      version: VERSION,
      jwtConfigured: Boolean(JWT_SECRET),
    });
  }
  if (req.url === '/ready') {
    const body = await readiness();
    return sendJson(res, body.ok ? 200 : 503, body);
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
      const code = e.code === 'payload_too_large' ? 413 : 400;
      return sendJson(res, code, { error: e.code || String(e.message || e) });
    }
  }
  sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', async () => {
  try {
    await jobStore.ensureSchema();
    await jobStore.reclaimStaleRunning();
    console.log('[knowledge-mcp] job schema ready');
  } catch (e) {
    console.error('[knowledge-mcp] job schema init failed', String(e.message || e));
  }
  console.log('[knowledge-mcp] listening on ' + PORT + ' v' + VERSION);
});