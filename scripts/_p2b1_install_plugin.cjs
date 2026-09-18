const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const ROOT = 'D:\\mind-map'
const CTR = 'mind-map-openclaw-gateway-1'
function sh(cmd) {
  console.log('>>', cmd)
  return execSync(cmd, { encoding: 'utf8', cwd: ROOT, windowsHide: true })
}

// Read secret from .env
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
const sm = env.match(/^OPENCLAW_LIANGCE_HANDOFF_SECRET=(.+)$/m)
if (!sm || sm[1].trim().length < 32) throw new Error('missing handoff secret in .env')
const secret = sm[1].trim()
console.log('secret len', secret.length)

// Strip BOM from plugin and ensure package files
const pluginLocal = path.join(ROOT, 'integrations/openclaw/liangce-ingress')
let idx = fs.readFileSync(path.join(pluginLocal, 'index.js'), 'utf8')
if (idx.charCodeAt(0) === 0xfeff) idx = idx.slice(1)
fs.writeFileSync(path.join(pluginLocal, 'index.js'), idx)

// Copy plugin into container extensions
sh(`docker exec ${CTR} mkdir -p /home/node/.openclaw/extensions/liangce-ingress`)
sh(`docker cp "${pluginLocal}/index.js" ${CTR}:/home/node/.openclaw/extensions/liangce-ingress/index.js`)
sh(`docker cp "${pluginLocal}/package.json" ${CTR}:/home/node/.openclaw/extensions/liangce-ingress/package.json`)
if (fs.existsSync(path.join(pluginLocal, 'openclaw.plugin.json'))) {
  sh(`docker cp "${pluginLocal}/openclaw.plugin.json" ${CTR}:/home/node/.openclaw/extensions/liangce-ingress/openclaw.plugin.json`)
}

// Pull config, patch, push back (same pattern as openclaw-docker.js)
const tmp = path.join(ROOT, '.tmp', 'openclaw.p2b1.json')
fs.mkdirSync(path.dirname(tmp), { recursive: true })
sh(`docker cp ${CTR}:/home/node/.openclaw/openclaw.json "${tmp}"`)
const cfg = JSON.parse(fs.readFileSync(tmp, 'utf8'))
cfg.plugins = cfg.plugins || {}
cfg.plugins.entries = cfg.plugins.entries || {}
cfg.plugins.load = cfg.plugins.load || {}
cfg.plugins.load.paths = Array.isArray(cfg.plugins.load.paths) ? cfg.plugins.load.paths : []
const extPath = '/home/node/.openclaw/extensions/liangce-ingress'
if (!cfg.plugins.load.paths.includes(extPath)) cfg.plugins.load.paths.push(extPath)
cfg.plugins.entries['liangce-ingress'] = {
  ...(cfg.plugins.entries['liangce-ingress'] || {}),
  enabled: true,
  config: {
    ...((cfg.plugins.entries['liangce-ingress'] && cfg.plugins.entries['liangce-ingress'].config) || {}),
    handoffSecret: secret
  }
}
// NEVER touch Cognee memory slot
if (!cfg.plugins.slots) cfg.plugins.slots = {}
if (cfg.plugins.slots.memory !== 'cognee-openclaw') {
  console.warn('WARNING: memory slot was', cfg.plugins.slots.memory, '- restoring cognee-openclaw')
  cfg.plugins.slots.memory = 'cognee-openclaw'
}
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
sh(`docker cp "${tmp}" ${CTR}:/home/node/.openclaw/openclaw.json`)
sh(`docker exec ${CTR} sh -lc "chown node:node /home/node/.openclaw/openclaw.json /home/node/.openclaw/extensions/liangce-ingress -R 2>/dev/null; chmod 600 /home/node/.openclaw/openclaw.json"`)

// Also set env on running container via a tiny wrapper file the plugin can read — already using plugin config handoffSecret

console.log('memory slot =', cfg.plugins.slots.memory)
console.log('liangce entry =', JSON.stringify(cfg.plugins.entries['liangce-ingress'], null, 2).replace(secret, '***'))
console.log('load.paths =', cfg.plugins.load.paths)

// Restart gateway to load plugin
sh(`docker restart ${CTR}`)
console.log('restarted; waiting health...')
