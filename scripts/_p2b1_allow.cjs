const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const ROOT = 'D:\\mind-map'
const CTR = 'mind-map-openclaw-gateway-1'
const pluginDir = path.join(ROOT, 'integrations/openclaw/liangce-ingress')
function sh(c){ console.log('>>', c.slice(0,140)); return execSync(c,{encoding:'utf8',cwd:ROOT,windowsHide:true}) }

// Rewrite plugin: HTTP + fail-closed only; declare who_am_i in contracts; keep tool
const indexJs = fs.readFileSync(path.join(pluginDir,'index.js'),'utf8')
// Fix registerTool -> optional and ensure contracts
const manifest = {
  id: 'liangce-ingress',
  name: 'Liangce Trusted Ingress',
  description: 'Phase 2B-1 Signed Handoff ingress',
  contracts: {
    tools: ['who_am_i']
  },
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      handoffSecret: { type: 'string', minLength: 32 }
    }
  }
}
fs.writeFileSync(path.join(pluginDir,'openclaw.plugin.json'), JSON.stringify(manifest,null,2))

// Also write openclaw.plugin.json as alias if loader expects that name
fs.writeFileSync(path.join(pluginDir,'openclaw.plugin.json'), JSON.stringify(manifest,null,2))

sh(`docker cp "${pluginDir}/index.js" ${CTR}:/home/node/.openclaw/extensions/liangce-ingress/index.js`)
sh(`docker cp "${pluginDir}/openclaw.plugin.json" ${CTR}:/home/node/.openclaw/extensions/liangce-ingress/openclaw.plugin.json`)
sh(`docker cp "${pluginDir}/openclaw.plugin.json" ${CTR}:/home/node/.openclaw/extensions/liangce-ingress/openclaw.plugin.json`)

// Patch allow list
const tmp = path.join(ROOT,'.tmp','oc2.json')
sh(`docker cp ${CTR}:/home/node/.openclaw/openclaw.json "${tmp}"`)
const cfg = JSON.parse(fs.readFileSync(tmp,'utf8'))
cfg.plugins = cfg.plugins || {}
cfg.plugins.allow = Array.from(new Set([...(cfg.plugins.allow||[]), 'liangce-ingress', 'cognee-openclaw', 'deepseek']))
cfg.plugins.slots = cfg.plugins.slots || {}
cfg.plugins.slots.memory = 'cognee-openclaw'
cfg.plugins.entries = cfg.plugins.entries || {}
cfg.plugins.entries['liangce-ingress'] = {
  enabled: true,
  config: {
    handoffSecret: (cfg.plugins.entries['liangce-ingress']?.config?.handoffSecret) ||
      (fs.readFileSync(path.join(ROOT,'.env'),'utf8').match(/^OPENCLAW_LIANGCE_HANDOFF_SECRET=(.+)$/m)||[])[1]?.trim()
  }
}
fs.writeFileSync(tmp, JSON.stringify(cfg,null,2))
sh(`docker cp "${tmp}" ${CTR}:/home/node/.openclaw/openclaw.json`)

console.log('allow=', cfg.plugins.allow)
console.log(sh(`docker exec ${CTR} openclaw plugins doctor 2>&1`).slice(0,1500))

sh(`docker restart ${CTR}`)
