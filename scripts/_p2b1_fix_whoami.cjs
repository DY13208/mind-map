const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const ROOT = 'D:\\mind-map'
const CTR = 'mind-map-openclaw-gateway-1'
const p = path.join(ROOT, 'integrations/openclaw/liangce-ingress/index.js')
let src = fs.readFileSync(p, 'utf8')

// Fix registerTool opts: name required, not optional (optional hides from agent)
src = src.replace(
  /api\.registerTool\(\s*\(ctx\)\s*=>\s*\(\{[\s\S]*?\}\),\s*\{[^}]*\}\s*\)/,
  `api.registerTool(
      (ctx) => ({
        name: "who_am_i",
        label: "Who Am I",
        description:
          "Return host-trusted OpenClaw requester identity from this turn. Never invent identity.",
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
    )`
)

// Ensure MCP resolver API name variants
if (!src.includes('registerMcpServerConnectionResolver') && src.includes('registerMcp')) {
  // keep existing
} else if (src.includes('registerMcpServerConnectionResolver')) {
  // ok
} else {
  // add after registerTool block a safe optional resolver
  src = src.replace(
    /api\.logger\?\.info\?\?\("\[liangce-ingress\] ready/,
    `if (typeof api.registerMcpServerConnectionResolver === "function") {
      api.registerMcpServerConnectionResolver({
        serverName: "liangce-identity-mcp",
        resolve: async (ctx) => {
          const sender = String(ctx?.requesterSenderId || "").trim();
          if (!sender) return null;
          lastResolverSender = sender;
          return null;
        },
      });
    }

    api.logger?.info?.("[liangce-ingress] ready`
  )
}

fs.writeFileSync(p, src)
const manifest = {
  id: 'liangce-ingress',
  name: 'Liangce Trusted Ingress',
  description: 'Phase 2B-1 Signed Handoff ingress',
  contracts: { tools: ['who_am_i'] },
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { handoffSecret: { type: 'string', minLength: 32 } }
  }
}
fs.writeFileSync(path.join(ROOT,'integrations/openclaw/liangce-ingress/openclaw.plugin.json'), JSON.stringify(manifest,null,2))

function sh(c){ console.log('>>', c.slice(0,100)); return execSync(c,{encoding:'utf8',cwd:ROOT,windowsHide:true}) }
sh(`docker cp "${p}" ${CTR}:/home/node/.openclaw/extensions/liangce-ingress/index.js`)
sh(`docker cp "${path.join(ROOT,'integrations/openclaw/liangce-ingress/openclaw.plugin.json')}" ${CTR}:/home/node/.openclaw/extensions/liangce-ingress/openclaw.plugin.json`)
sh(`docker restart ${CTR}`)
console.log('restarted')
