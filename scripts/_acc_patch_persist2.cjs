const fs = require('fs')
const p = 'scripts/openclaw-docker.js'
let s = fs.readFileSync(p, 'utf8')
if (s.includes('LIANGCE_INGRESS_PERSIST')) {
  console.log('already patched')
  process.exit(0)
}
const start = s.indexOf('  if (cogneeActive) {')
const end = s.indexOf('  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)', start)
if (start < 0 || end < 0) {
  console.error('markers missing', start, end)
  process.exit(1)
}
// find the cogneeActive block that is followed soon by writeFileSync — take last occurrence before writeFileSync of ensureOpenclawConfig
const writeIdx = s.indexOf(
  "  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\\n', 'utf8')\r\n  return CONFIG_FILE"
)
const blockStart = s.lastIndexOf('  if (cogneeActive) {', writeIdx)
if (blockStart < 0 || writeIdx < 0) {
  console.error('block/write missing', blockStart, writeIdx)
  process.exit(1)
}
const inject = `  if (cogneeActive) {
    cfg.plugins = cfg.plugins || {}
    cfg.plugins.entries = cfg.plugins.entries || {}
    cfg.plugins.entries[COGNEE_PLUGIN_ID] =
      cfg.plugins.entries[COGNEE_PLUGIN_ID] || {}
    cfg.plugins.entries[COGNEE_PLUGIN_ID].enabled = true
    cfg.plugins.slots = cfg.plugins.slots || {}
    cfg.plugins.slots.memory = COGNEE_PLUGIN_ID
  }

  /* LIANGCE_INGRESS_PERSIST */
  {
    const LIANGCE_ID = 'liangce-ingress'
    const LIANGCE_PATH = '/home/node/.openclaw/extensions/liangce-ingress'
    cfg.plugins = cfg.plugins || {}
    cfg.plugins.entries = cfg.plugins.entries || {}
    const prevLiangce = cfg.plugins.entries[LIANGCE_ID] || {}
    const envMap = loadEnvFile()
    const envSecret = String(
      process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET ||
        envMap.OPENCLAW_LIANGCE_HANDOFF_SECRET ||
        (prevLiangce.config && prevLiangce.config.handoffSecret) ||
        ''
    ).trim()
    cfg.plugins.entries[LIANGCE_ID] = {
      ...prevLiangce,
      enabled: true,
      config: {
        ...(prevLiangce.config || {}),
        ...(envSecret ? { handoffSecret: envSecret } : {})
      }
    }
    cfg.plugins.load = cfg.plugins.load || {}
    const paths = Array.isArray(cfg.plugins.load.paths)
      ? cfg.plugins.load.paths.slice()
      : []
    if (!paths.includes(LIANGCE_PATH)) paths.push(LIANGCE_PATH)
    cfg.plugins.load.paths = paths
    if (Array.isArray(cfg.plugins.allow) && cfg.plugins.allow.length) {
      const allow = new Set(cfg.plugins.allow.map(String))
      allow.add(LIANGCE_ID)
      if (cogneeActive) allow.add(COGNEE_PLUGIN_ID)
      cfg.plugins.allow = Array.from(allow)
    }
    if (cogneeActive) {
      cfg.plugins.slots = cfg.plugins.slots || {}
      cfg.plugins.slots.memory = COGNEE_PLUGIN_ID
    }
  }

`
s = s.slice(0, blockStart) + inject.replace(/\n/g, '\r\n') + s.slice(writeIdx)
fs.writeFileSync(p, s)
console.log('patched', s.includes('LIANGCE_INGRESS_PERSIST'))
