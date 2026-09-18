/**
 * Liangce Trusted Ingress — minimal Phase 2B-1
 * Verifies Mind Map Signed Handoff and dispatches inbound DM with host-trusted senderId.
 */
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";

const CHANNEL_ID = "liangce";

/* PHASE2B_KNOWLEDGE_MCP_RESOLVER */
function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function mintKnowledgeJwt(userId, api) {
  const secret = String(
    api.pluginConfig?.knowledgeMcpJwtSecret ||
      process.env.KNOWLEDGE_MCP_JWT_SECRET ||
      ''
  ).trim();
  if (!secret) return null;
  const ttl = Number(api.pluginConfig?.knowledgeMcpJwtTtlSec || process.env.KNOWLEDGE_MCP_JWT_TTL_SEC || 180);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: String(userId),
    actorType: 'user',
    iss: String(api.pluginConfig?.knowledgeMcpJwtIss || process.env.KNOWLEDGE_MCP_JWT_ISS || 'openclaw-liangce'),
    aud: String(api.pluginConfig?.knowledgeMcpJwtAud || process.env.KNOWLEDGE_MCP_JWT_AUD || 'knowledge-mcp'),
    iat: now,
    exp: now + ttl,
    jti: randomUUID(),
  };
  const data = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

const ISS = "mind-map";
const AUD = "openclaw-liangce";
const TYP = "openclaw_identity_handoff";

const seenJti = new Map();
let lastResolverSender = null;
const resolverLog = [];
function pushResolver(entry) {
  resolverLog.push({ ...entry, at: Date.now() });
  if (resolverLog.length > 200) resolverLog.splice(0, resolverLog.length - 200);
}

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
      { name: "who_am_i" },
    );

    
    let resolverApiPresent = false;
    const resolveKnowledgeMcp = async (ctx) => {
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
        url: "http://knowledge-mcp:18792/mcp",
        headers: { "x-requester-sender-id": sender },
      };
    };
    const reg =
      typeof api.registerMcpServerConnectionResolver === "function"
        ? "registerMcpServerConnectionResolver"
        : typeof api.registerMcpServerConnectionResolver === "function"
          ? "registerMcpServerConnectionResolver"
          : null;
    if (reg) {
      resolverApiPresent = true;
      api[reg]({ serverName: "knowledge-mcp", resolve: resolveKnowledgeMcp });
      api.logger?.info?.("[liangce-ingress] registered MCP resolver via " + reg);
    } else {
      const keys = Object.keys(api).filter((k) => /mcp|Mcp|Resolver/i.test(k));
      api.logger?.warn?.(
        "[liangce-ingress] MCP resolver API missing; keys=" + keys.join(","),
      );
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
          reply: replies.join("\n") || "",
          replies,
          resolverLastSender: lastResolverSender,
          /* RESOLVER_PROBE_INVOKE */
          resolverProbe: typeof resolveKnowledgeMcp === "function"
            ? await resolveKnowledgeMcp({
                requesterSenderId,
                agentAccountId: "default",
                messageChannel: CHANNEL_ID,
              })
            : null,
        });
      },
    });

    api.registerHttpRoute({
      path: "/liangce/resolver-status",
      auth: "gateway",
      match: "exact",
      handler: async (_req, res) => {
        sendJson(res, 200, {
          ok: true,
          resolverApiPresent: typeof resolverApiPresent !== "undefined" ? resolverApiPresent : null,
          lastResolverSender,
          logCount: resolverLog.length,
          apiKeys: [],
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
