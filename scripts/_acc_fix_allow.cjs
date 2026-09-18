const fs = require('fs')
const { execSync } = require('child_process')
const tmp = 'D:/mind-map/.tmp'
function sh(c){ console.log('>>', c.slice(0,120)); return execSync(c,{encoding:'utf8',windowsHide:true}) }

// Fix allow list: either remove allow (open) or keep essential + liangce without excluding stock
const cfg = JSON.parse(fs.readFileSync(tmp + '/oc-now.json','utf8'))
const before = JSON.stringify(cfg.plugins.allow)
delete cfg.plugins.allow  // fail-open for stock plugins; entries.enabled still controls liangce
// Keep load.paths + entries + cognee slot
cfg.plugins.slots = cfg.plugins.slots || {}
cfg.plugins.slots.memory = 'cognee-openclaw'
cfg.plugins.entries = cfg.plugins.entries || {}
cfg.plugins.entries['liangce-ingress'] = cfg.plugins.entries['liangce-ingress'] || { enabled: true }
cfg.plugins.entries['liangce-ingress'].enabled = true
cfg.plugins.entries['cognee-openclaw'] = cfg.plugins.entries['cognee-openclaw'] || { enabled: true }
cfg.plugins.entries['cognee-openclaw'].enabled = true
cfg.plugins.load = cfg.plugins.load || {}
cfg.plugins.load.paths = Array.from(new Set([...(cfg.plugins.load.paths||[]), '/home/node/.openclaw/extensions/liangce-ingress']))

fs.writeFileSync(tmp + '/oc-fixed.json', JSON.stringify(cfg, null, 2))
console.log('allow before', before)
console.log('allow after', cfg.plugins.allow)

sh(`docker run --rm -v mind-map_mind-map-openclaw:/data -v ${tmp}:/out alpine sh -c "cp /out/oc-fixed.json /data/openclaw.json; chown 1000:1000 /data/openclaw.json; chmod 600 /data/openclaw.json"`)

// Ensure plugin files exist with correct names
sh(`docker run --rm -v mind-map_mind-map-openclaw:/data -v D:/mind-map/integrations/openclaw/liangce-ingress:/src alpine sh -c "mkdir -p /data/extensions/liangce-ingress; cp -f /src/index.js /src/package.json /data/extensions/liangce-ingress/; if [ -f /src/openclaw.plugin.json ]; then cp /src/openclaw.plugin.json /data/extensions/liangce-ingress/; fi; if [ -f /src/openclaw.plugin.json ]; then cp /src/openclaw.plugin.json /data/extensions/liangce-ingress/openclaw.plugin.json; fi; ls -la /data/extensions/liangce-ingress; chown -R 1000:1000 /data/extensions/liangce-ingress"`)

sh('docker compose up -d --no-deps openclaw-gateway')
