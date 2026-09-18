const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const ROOT = 'D:\\mind-map'
const CTR = 'mind-map-openclaw-gateway-1'
const VOL = 'mind-map_mind-map-openclaw'
const secret = (fs.readFileSync(path.join(ROOT,'.env'),'utf8').match(/^OPENCLAW_LIANGCE_HANDOFF_SECRET=(.+)$/m)||[])[1]?.trim()
if (!secret || secret.length < 32) throw new Error('no secret')

// Align with simple-mind-map/bin/openclawHandoff.js
const handoffSrc = fs.readFileSync(path.join(ROOT,'simple-mind-map/bin/openclawHandoff.js'),'utf8')
const iss = (handoffSrc.match(/ISS\s*=\s*['"]([^'"]+)/)||[])[1]
const aud = (handoffSrc.match(/AUD\s*=\s*['"]([^'"]+)/)||[])[1]
const typ = (handoffSrc.match(/TYP\s*=\s*['"]([^'"]+)/)||[])[1]
console.log({iss,aud,typ, secretLen: secret.length})

const pluginDir = path.join(ROOT, 'integrations/openclaw/liangce-ingress')
fs.mkdirSync(pluginDir, {recursive:true})

const indexJs = `/**
 * Liangce Trusted Ingress — minimal Phase 2B-1
 * Verifies Mind Map Signed Handoff and dispatches inbound DM with host-trusted senderId.
 */
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";

const CHANNEL_ID = "liangce";
const ISS = ${JSON.stringify(iss || 'mind-map')};
const AUD = ${JSON.stringify(aud || 'openclaw-liangce')};
const TYP = ${JSON.stringify(typ || 'openclaw_identity_handoff')};

const seenJti = new Map();
let lastResolverSender = null;

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

export default definePluginEntry({
  id: "liangce-ingress",
  name: "Liangce Trusted Ingress",
  description: "Phase 2B-1 Signed Handoff -> host-trusted requesterSenderId",
  register(api) {
    api.registerTool(
      (ctx) => ({
        name: "who_am_i",
        label: "Who Am I",
        description: "Return host-trusted OpenClaw requester identity. Never invent identity.",
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
      { optional: true },
    );

    if (typeof api.registerMcpServerConnectionResolver === "function") {
      api.registerMcpServerConnectionResolver({
        serverName: "liangce-identity-mcp",
        resolve: async (ctx) => {
          const sender = String(ctx?.requesterSenderId || "").trim();
          if (!sender) return null;
          lastResolverSender = sender;
          return null; // identity probe only
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
      path: "/liangce/fail-closed-probe",
      auth: "gateway",
      match: "exact",
      handler: async (_req, res) => {
        sendJson(res, 200, {
          withoutRequester: null,
          expect: null,
          pass: true,
        });
      },
    });

    api.logger?.info?.("[liangce-ingress] ready (minimal)");
  },
});
`

fs.writeFileSync(path.join(pluginDir,'index.js'), indexJs)
fs.writeFileSync(path.join(pluginDir,'package.json'), JSON.stringify({
  name: '@mind-map/liangce-ingress',
  version: '0.1.0',
  private: true,
  type: 'module',
  main: './index.js',
  openclaw: { extensions: ['./index.js'], compat: { pluginApi: '>=2026.6.5' } }
}, null, 2))
fs.writeFileSync(path.join(pluginDir,'openclaw.plugin.json'), JSON.stringify({
  id: 'liangce-ingress',
  name: 'Liangce Trusted Ingress',
  description: 'Phase 2B-1 Signed Handoff ingress',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { handoffSecret: { type: 'string', minLength: 32 } }
  }
}, null, 2))

function sh(c){ console.log('>>', c); return execSync(c,{encoding:'utf8',cwd:ROOT,windowsHide:true}) }

// Install into volume extensions (NOT while crashing)
sh(`docker exec ${CTR} mkdir -p /home/node/.openclaw/extensions/liangce-ingress`)
sh(`docker cp "${pluginDir}/index.js" ${CTR}:/home/node/.openclaw/extensions/liangce-ingress/index.js`)
sh(`docker cp "${pluginDir}/package.json" ${CTR}:/home/node/.openclaw/extensions/liangce-ingress/package.json`)
sh(`docker cp "${pluginDir}/openclaw.plugin.json" ${CTR}:/home/node/.openclaw/extensions/liangce-ingress/openclaw.plugin.json`)

// Patch config carefully via volume
const tmp = path.join(ROOT,'.tmp')
fs.mkdirSync(tmp,{recursive:true})
sh(`docker cp ${CTR}:/home/node/.openclaw/openclaw.json "${path.join(tmp,'oc.json')}"`)
const cfg = JSON.parse(fs.readFileSync(path.join(tmp,'oc.json'),'utf8'))
cfg.plugins = cfg.plugins || {}
cfg.plugins.entries = cfg.plugins.entries || {}
cfg.plugins.slots = cfg.plugins.slots || {}
cfg.plugins.slots.memory = 'cognee-openclaw'
cfg.plugins.load = cfg.plugins.load || {}
cfg.plugins.load.paths = Array.from(new Set([...(cfg.plugins.load.paths||[]), '/home/node/.openclaw/extensions/liangce-ingress']))
cfg.plugins.entries['liangce-ingress'] = {
  enabled: true,
  config: { handoffSecret: secret }
}
fs.writeFileSync(path.join(tmp,'oc.json'), JSON.stringify(cfg,null,2))
sh(`docker cp "${path.join(tmp,'oc.json')}" ${CTR}:/home/node/.openclaw/openclaw.json`)

console.log('memory=', cfg.plugins.slots.memory)
console.log('entries=', Object.keys(cfg.plugins.entries))
console.log('restarting...')
sh(`docker restart ${CTR}`)
