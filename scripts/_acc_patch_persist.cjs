const fs = require('fs')
const path = require('path')

// --- 1) Patch openclaw-docker.js to preserve liangce-ingress ---
const dockerJs = path.join('scripts', 'openclaw-docker.js')
let src = fs.readFileSync(dockerJs, 'utf8')
const marker = '/* LIANGCE_INGRESS_PERSIST */'
if (!src.includes(marker)) {
  const needle = `  // 仅当插件确实在卷内时，才强制启用 Cognee memory slot；否则 Gateway 会因插件缺失崩溃重启。
  if (cogneeActive) {
    cfg.plugins = cfg.plugins || {}
    cfg.plugins.entries = cfg.plugins.entries || {}
    cfg.plugins.entries[COGNEE_PLUGIN_ID] =
      cfg.plugins.entries[COGNEE_PLUGIN_ID] || {}
    cfg.plugins.entries[COGNEE_PLUGIN_ID].enabled = true
    cfg.plugins.slots = cfg.plugins.slots || {}
    cfg.plugins.slots.memory = COGNEE_PLUGIN_ID
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\\n', 'utf8')`
  const insert = `  // 仅当插件确实在卷内时，才强制启用 Cognee memory slot；否则 Gateway 会因插件缺失崩溃重启。
  if (cogneeActive) {
    cfg.plugins = cfg.plugins || {}
    cfg.plugins.entries = cfg.plugins.entries || {}
    cfg.plugins.entries[COGNEE_PLUGIN_ID] =
      cfg.plugins.entries[COGNEE_PLUGIN_ID] || {}
    cfg.plugins.entries[COGNEE_PLUGIN_ID].enabled = true
    cfg.plugins.slots = cfg.plugins.slots || {}
    cfg.plugins.slots.memory = COGNEE_PLUGIN_ID
  }

  ${marker}
  // Phase 2B-1: preserve Liangce Trusted Ingress across Start-Docker / syncConfigIntoVolume.
  // Never wipe load.paths or replace a narrow plugins.allow that would break stock plugins.
  {
    const LIANGCE_ID = 'liangce-ingress'
    const LIANGCE_PATH = '/home/node/.openclaw/extensions/liangce-ingress'
    cfg.plugins = cfg.plugins || {}
    cfg.plugins.entries = cfg.plugins.entries || {}
    const prevLiangce = cfg.plugins.entries[LIANGCE_ID] || {}
    const envSecret = String(
      process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET ||
        loadEnvFile().OPENCLAW_LIANGCE_HANDOFF_SECRET ||
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
    const paths = Array.isArray(cfg.plugins.load.paths) ? cfg.plugins.load.paths.slice() : []
    if (!paths.includes(LIANGCE_PATH)) paths.push(LIANGCE_PATH)
    cfg.plugins.load.paths = paths
    // If allowlist exists, ensure liangce + cognee are present; do NOT create a tiny allowlist.
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

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\\n', 'utf8')`
  if (!src.includes(needle.split('\n')[0])) {
    console.error('needle not found for docker.js patch')
    process.exit(1)
  }
  // Use more reliable replace on unique end block
  const re = /if \(cogneeActive\) \{[\s\S]*?cfg\.plugins\.slots\.memory = COGNEE_PLUGIN_ID\n  \}\n\n  fs\.writeFileSync\(CONFIG_FILE/
  if (!re.test(src)) {
    console.error('regex miss')
    process.exit(1)
  }
  src = src.replace(re, `if (cogneeActive) {
    cfg.plugins = cfg.plugins || {}
    cfg.plugins.entries = cfg.plugins.entries || {}
    cfg.plugins.entries[COGNEE_PLUGIN_ID] =
      cfg.plugins.entries[COGNEE_PLUGIN_ID] || {}
    cfg.plugins.entries[COGNEE_PLUGIN_ID].enabled = true
    cfg.plugins.slots = cfg.plugins.slots || {}
    cfg.plugins.slots.memory = COGNEE_PLUGIN_ID
  }

  ${marker}
  {
    const LIANGCE_ID = 'liangce-ingress'
    const LIANGCE_PATH = '/home/node/.openclaw/extensions/liangce-ingress'
    cfg.plugins = cfg.plugins || {}
    cfg.plugins.entries = cfg.plugins.entries || {}
    const prevLiangce = cfg.plugins.entries[LIANGCE_ID] || {}
    const envSecret = String(
      process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET ||
        loadEnvFile().OPENCLAW_LIANGCE_HANDOFF_SECRET ||
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

  fs.writeFileSync(CONFIG_FILE`)
  fs.writeFileSync(dockerJs, src)
  console.log('patched openclaw-docker.js')
} else {
  console.log('openclaw-docker.js already patched')
}
