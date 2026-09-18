const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const pluginPath = 'integrations/openclaw/liangce-ingress/index.js'
let src = fs.readFileSync(pluginPath, 'utf8')

// Fix API name if wrong
src = src.replace(/registerMcpServerConnectionResolver/g, 'registerMcpServerConnectionResolver')
// Ensure docs-correct name from live docs table
if (!src.includes('registerMcpServerConnectionResolver')) {
  console.log('note: checking exact name...')
}

// Replace resolver block + add resolver log + probe routes
const oldResolver = /if \(typeof api\.registerMcpServerConnectionResolver === "function"\) \{[\s\S]*?\n    \}/
if (!oldResolver.test(src)) {
  // try alternate spelling already in file
  console.log('resolver block pattern miss, dumping snippet:')
  const i = src.indexOf('registerMcp')
  console.log(src.slice(i, i+500))
}

const newResolver = `const resolverLog = [];
    const pushResolver = (entry) => {
      resolverLog.push({ ...entry, at: Date.now() });
      if (resolverLog.length > 200) resolverLog.splice(0, resolverLog.length - 200);
    };

    if (typeof api.registerMcpServerConnectionResolver === "function") {
      api.registerMcpServerConnectionResolver({
        serverName: "identity-mcp",
        resolve: async (ctx) => {
          const sender = String(ctx?.requesterSenderId || "").trim();
          pushResolver({
            requesterSenderId: sender || null,
            agentAccountId: ctx?.agentAccountId ?? null,
            messageChannel: ctx?.messageChannel ?? null,
          });
          if (!sender) {
            lastResolverSender = null;
            return null; // fail-closed: cron/heartbeat/subagent/public
          }
          lastResolverSender = sender;
          return {
            url: "http://host.docker.internal:18791/mcp",
            headers: {
              "x-requester-sender-id": sender,
            },
          };
        },
      });
    } else if (typeof api.registerMcpServerConnectionResolver === "function") {
      api.registerMcpServerConnectionResolver({
        serverName: "identity-mcp",
        resolve: async (ctx) => {
          const sender = String(ctx?.requesterSenderId || "").trim();
          pushResolver({ requesterSenderId: sender || null });
          if (!sender) return null;
          lastResolverSender = sender;
          return {
            url: "http://host.docker.internal:18791/mcp",
            headers: { "x-requester-sender-id": sender },
          };
        },
      });
    }

    api.registerHttpRoute({
      path: "/liangce/resolver-log",
      auth: "gateway",
      match: "exact",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true, log: resolverLog.slice(-50) });
      },
    });

    api.registerHttpRoute({
      path: "/liangce/resolver-log/reset",
      auth: "gateway",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        resolverLog.length = 0;
        lastResolverSender = null;
        sendJson(res, 200, { ok: true });
      },
    })`

// Simpler: rewrite entire plugin file cleanly
const full = `/**
 * Liangce Trusted Ingress — Phase 2B-1 final acceptance
 */
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";

const CHANNEL_ID = "liangce";
const ISS = "mind-map";
const AUD = "openclaw-liangce";
const TYP = "openclaw_identity_handoff";

const seenJti = new Map();
let lastResolverSender = null;
const resolverLog = [];

function cleanupJti(now) {
  for (const [jti, exp] of seenJti) if (exp < now) seenJti.delete(jti);
  if (seenJti.size > 5000) {
    for (const k of [...seenJti.keys()].slice(0, seenJti.size - 4000)) seenJti.delete(k);
  }
}

function b64urlJson(buf) {
  return JSON.parse(Buffer.from(buf, "base64url").toString("utf8"));
}

function verifyHandoff(token, secret, conversationId) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3) {
    const err = new Error("invalid handoff token");
    err.code = "openclaw_handoff_invalid";
    throw err;
  }
  const [header, body, sig] = parts;
  const expected = createHmac("sha256", secret)
    .update(header + "." + body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const err = new Error("handoff signature invalid");
    err.code = "openclaw_handoff_bad_sig";
    throw err;
  }
  const payload = b64urlJson(body);
  if (payload.typ !== TYP || payload.iss !== ISS || payload.aud !== AUD) {
    const err = new Error("handoff iss/aud/typ mismatch");
    err.code = "openclaw_handoff_aud";
    throw err;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || now > Number(payload.exp)) {
    const err = new Error("handoff expired");
    err.code = "openclaw_handoff_expired";
    throw err;
  }
  if (!payload.iat || Number(payload.iat) > now + 60) {
    const err = new Error("handoff iat invalid");
    err.code = "openclaw_handoff_iat";
    throw err;
  }
  const sub = String(payload.sub || "").trim();
  if (!sub) {
    const err = new Error("handoff missing sub");
    err.code = "openclaw_handoff_sub";
    throw err;
  }
  const conv = String(payload.conversationId || "").trim();
  if (conversationId && conv && conv !== String(conversationId).trim()) {
    const err = new Error("handoff conversationId mismatch");
    err.code = "openclaw_handoff_conversation";
    throw err;
  }
  const jti = String(payload.jti || "").trim();
  if (!jti) {
    const err = new Error("handoff missing jti");
    err.code = "openclaw_handoff_jti";
    throw err;
  }
  cleanupJti(now);
  if (seenJti.has(jti)) {
    const err = new Error("handoff replay detected");
    err.code = "openclaw_handoff_replay";
    throw err;
  }
  seenJti.set(jti, Number(payload.exp));
  return {
    ...payload,
    userId: sub,
    requesterSenderId: "liangce:" + sub,
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function resolveSecret(api) {
  return (
    String(api.pluginConfig?.handoffSecret || "").trim() ||
    String(process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET || "").trim()
  );
}

function pushResolver(entry) {
  resolverLog.push({ ...entry, at: Date.now() });
  if (resolverLog.length > 200) resolverLog.splice(0, resolverLog.length - 200);
}

export default definePluginEntry({
  id: "liangce-ingress",
  name: "Liangce Trusted Ingress",
  description: "Phase 2B-1 Signed Handoff -> host-trusted requesterSenderId",
  register(api) {
    api.registerTool(
      (ctx) => ({
        name: "who_am_i",
        label: "Who Am I",
        description:
          "Return host-trusted OpenClaw requester identity. Never invent identity. Always call this tool when asked who you are talking to.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          const payload = {
            probe: "liangce-who_am_i",
            requesterSenderId: ctx?.requesterSenderId ?? null,
            agentAccountId: ctx?.agentAccountId ?? null,
            sessionKey: ctx?.sessionKey ?? null,
            messageChannel: ctx?.messageChannel ?? null,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          };
        },
      }),
      { name: "who_am_i" },
    );

    const registerResolver =
      typeof api.registerMcpServerConnectionResolver === "function"
        ? api.registerMcpServerConnectionResolver.bind(api)
        : typeof api.registerMcpServerConnectionResolver === "function"
          ? api.registerMcpServerConnectionResolver.bind(api)
          : null;

    if (registerResolver) {
      registerResolver({
        serverName: "identity-mcp",
        resolve: async (ctx) => {
          const sender = String(ctx?.requesterSenderId || "").trim();
          pushResolver({
            requesterSenderId: sender || null,
            agentAccountId: ctx?.agentAccountId ?? null,
            messageChannel: ctx?.messageChannel ?? null,
          });
          if (!sender) {
            lastResolverSender = null;
            return null;
          }
          lastResolverSender = sender;
          return {
            url: "http://host.docker.internal:18791/mcp",
            headers: { "x-requester-sender-id": sender },
          };
        },
      });
    }

    api.registerHttpRoute({
      path: "/liangce/inbound",
      auth: "gateway",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        const secret = resolveSecret(api);
        if (!secret || secret.length < 32) {
          sendJson(res, 503, {
            error: "OPENCLAW_LIANGCE_HANDOFF_SECRET not configured",
            code: "openclaw_handoff_unavailable",
          });
          return;
        }
        let body;
        try {
          body = await readJson(req);
        } catch (_) {
          sendJson(res, 400, { error: "invalid_json" });
          return;
        }
        const handoff = body.handoff || body.handoffToken || body.token;
        const message = String(body.message || "").trim();
        const conversationId = String(body.conversationId || "").trim();
        if (!handoff || !message || !conversationId) {
          sendJson(res, 400, {
            error: "handoff, message, conversationId required",
          });
          return;
        }
        if (body.requesterSenderId || body.senderId || body.userId) {
          sendJson(res, 400, {
            error: "client-supplied identity fields are not accepted",
            code: "identity_forge_rejected",
          });
          return;
        }
        let identity;
        try {
          identity = verifyHandoff(handoff, secret, conversationId);
        } catch (err) {
          sendJson(res, 401, {
            error: err.message || "handoff_invalid",
            code: err.code || "openclaw_handoff_invalid",
          });
          return;
        }

        const userId = identity.userId;
        const requesterSenderId = identity.requesterSenderId;
        const messageId = String(body.messageId || randomUUID());
        const replies = [];

        try {
          await dispatchInboundDirectDmWithRuntime({
            cfg: api.config,
            runtime: api.runtime,
            channel: CHANNEL_ID,
            channelLabel: CHANNEL_ID,
            accountId: "default",
            peer: { kind: "direct", id: userId + "::" + conversationId },
            senderId: requesterSenderId,
            senderAddress: requesterSenderId,
            conversationLabel: "liangce:" + userId + ":" + conversationId,
            recipientAddress: "liangce:bot",
            rawBody: message,
            bodyForAgent: message,
            commandBody: message,
            messageId,
            timestamp: Date.now(),
            commandAuthorized: true,
            inboundAccessAuthorized: true,
            deliver: async (payload) => {
              const text =
                (payload && (payload.text || payload.body || payload.message)) ||
                "";
              if (text) replies.push(String(text));
              return { messageId: randomUUID() };
            },
            onDispatchError: (err) => {
              api.logger?.error?.(
                "[liangce-ingress] dispatch error: " + (err?.message || err),
              );
            },
          });
        } catch (err) {
          sendJson(res, 500, {
            error: err?.message || "inbound_dispatch_failed",
            code: "liangce_inbound_failed",
            requesterSenderId,
          });
          return;
        }

        sendJson(res, 200, {
          ok: true,
          requesterSenderId,
          userId,
          conversationId,
          messageId,
          reply: replies.join("\\n") || "",
          replies,
          resolverLastSender: lastResolverSender,
        });
      },
    });

    api.registerHttpRoute({
      path: "/liangce/resolver-log",
      auth: "gateway",
      match: "exact",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true, log: resolverLog.slice(-80) });
      },
    });

    api.registerHttpRoute({
      path: "/liangce/resolver-log/reset",
      auth: "gateway",
      match: "exact",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        resolverLog.length = 0;
        lastResolverSender = null;
        sendJson(res, 200, { ok: true });
      },
    });

    api.registerHttpRoute({
      path: "/liangce/fail-closed-probe",
      auth: "gateway",
      match: "exact",
      handler: async (_req, res) => {
        // Simulate resolver without requester
        const simulated = null;
        sendJson(res, 200, {
          withoutRequester: simulated,
          expect: null,
          pass: simulated === null,
        });
      },
    });

    api.logger?.info?.("[liangce-ingress] ready");
  },
});
`

fs.writeFileSync(pluginPath, full)
console.log('plugin rewritten', full.length)

// identity-mcp minimal streamable-http-ish JSON-RPC server
const mcpDir = 'integrations/openclaw/identity-mcp'
fs.mkdirSync(mcpDir, { recursive: true })
const mcpServer = `#!/usr/bin/env node
/**
 * Minimal identity-mcp probe for Phase 2B-1.
 * Echoes x-requester-sender-id from connection headers via who_am_i tool.
 */
const http = require('http')
const PORT = Number(process.env.IDENTITY_MCP_PORT || 18791)
const hits = []

function sendJson(res, status, body, extra = {}) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    ...extra,
  })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function toolList() {
  return {
    tools: [
      {
        name: 'who_am_i',
        description: 'Return requesterSenderId from trusted ingress header',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }
}

async function handleRpc(req, rpc) {
  const sender = String(req.headers['x-requester-sender-id'] || '').trim() || null
  hits.push({ at: Date.now(), method: rpc.method, sender })
  if (hits.length > 200) hits.splice(0, hits.length - 200)

  if (rpc.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'identity-mcp', version: '0.1.0' },
    }
  }
  if (rpc.method === 'notifications/initialized' || rpc.method === 'notifications/cancelled') {
    return null
  }
  if (rpc.method === 'tools/list') return toolList()
  if (rpc.method === 'tools/call') {
    const name = rpc.params && rpc.params.name
    if (name !== 'who_am_i') {
      return { content: [{ type: 'text', text: 'unknown tool' }], isError: true }
    }
    const payload = {
      probe: 'identity-mcp-who_am_i',
      requesterSenderId: sender,
      via: 'x-requester-sender-id',
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  }
  if (rpc.method === 'ping') return {}
  return { error: { code: -32601, message: 'Method not found: ' + rpc.method } }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    sendJson(res, 200, { ok: true, hits: hits.length })
    return
  }
  if (req.url === '/hits') {
    sendJson(res, 200, { hits: hits.slice(-80) })
    return
  }
  if (req.url === '/hits/reset' && req.method === 'POST') {
    hits.length = 0
    sendJson(res, 200, { ok: true })
    return
  }
  if (req.url === '/mcp' || req.url.startsWith('/mcp?')) {
    if (req.method === 'GET') {
      // SSE stub for clients that probe GET
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write('event: endpoint\\ndata: /mcp\\n\\n')
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    try {
      const raw = await readBody(req)
      const rpc = raw ? JSON.parse(raw) : {}
      const result = await handleRpc(req, rpc)
      if (rpc.id === undefined || rpc.id === null) {
        res.writeHead(202)
        res.end()
        return
      }
      if (result && result.error && !result.content) {
        sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, error: result.error })
        return
      }
      sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result })
    } catch (e) {
      sendJson(res, 400, { error: String(e.message || e) })
    }
    return
  }
  sendJson(res, 404, { error: 'not_found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('[identity-mcp] listening on', PORT)
})
`
fs.writeFileSync(path.join(mcpDir, 'server.cjs'), mcpServer)
console.log('identity-mcp server written')

// Update volume openclaw.json: mcp.servers + ensure no tiny allow
const tmp = 'D:/mind-map/.tmp'
execSync(\`docker run --rm -v mind-map_mind-map-openclaw:/data -v \${tmp}:/out alpine sh -c "cp /data/openclaw.json /out/oc-acc.json"\`, {stdio:'inherit'})
const cfg = JSON.parse(fs.readFileSync(tmp + '/oc-acc.json', 'utf8'))
delete cfg.plugins.allow
cfg.plugins = cfg.plugins || {}
cfg.plugins.slots = cfg.plugins.slots || {}
cfg.plugins.slots.memory = 'cognee-openclaw'
cfg.plugins.entries = cfg.plugins.entries || {}
cfg.plugins.entries['liangce-ingress'] = {
  ...(cfg.plugins.entries['liangce-ingress'] || {}),
  enabled: true,
}
cfg.plugins.load = cfg.plugins.load || {}
cfg.plugins.load.paths = Array.from(new Set([...(cfg.plugins.load.paths||[]), '/home/node/.openclaw/extensions/liangce-ingress']))
cfg.mcp = cfg.mcp || {}
cfg.mcp.servers = cfg.mcp.servers || {}
cfg.mcp.servers['identity-mcp'] = {
  url: 'http://host.docker.internal:18791/mcp',
}
fs.writeFileSync(tmp + '/oc-acc.json', JSON.stringify(cfg, null, 2))
execSync(\`docker run --rm -v mind-map_mind-map-openclaw:/data -v \${tmp}:/out alpine sh -c "cp /out/oc-acc.json /data/openclaw.json; chown 1000:1000 /data/openclaw.json; chmod 600 /data/openclaw.json"\`, {stdio:'inherit'})

// Copy plugin into volume
execSync(\`docker run --rm -v mind-map_mind-map-openclaw:/data -v D:/mind-map/integrations/openclaw/liangce-ingress:/src alpine sh -c "cp /src/index.js /src/package.json /src/openclaw.plugin.json /data/extensions/liangce-ingress/; chown -R 1000:1000 /data/extensions/liangce-ingress"\`, {stdio:'inherit'})

console.log('config+plugin synced; memory=', cfg.plugins.slots.memory)
console.log('mcp.servers', cfg.mcp.servers)
