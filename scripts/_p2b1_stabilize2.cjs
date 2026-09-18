const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const ROOT = 'D:\\mind-map'
const VOL = 'mind-map_mind-map-openclaw'
const tmp = path.join(ROOT, '.tmp')
fs.mkdirSync(tmp, { recursive: true })
function sh(c){ console.log('>>', c.slice(0,140)); return execSync(c,{encoding:'utf8',cwd:ROOT,windowsHide:true}) }

// Pull current config from volume; keep liangce enabled but ensure allow + cognee slot
sh(`docker run --rm -v ${VOL}:/data -v ${tmp.replace(/\\/g,'/')}:/out alpine sh -c "cp /data/openclaw.json /out/oc.live.json; ls /data/extensions"`)
const cfg = JSON.parse(fs.readFileSync(path.join(tmp,'oc.live.json'),'utf8'))
cfg.plugins = cfg.plugins || {}
cfg.plugins.allow = Array.from(new Set([...(cfg.plugins.allow||[]),'liangce-ingress','cognee-openclaw','deepseek']))
cfg.plugins.slots = cfg.plugins.slots || {}
cfg.plugins.slots.memory = 'cognee-openclaw'
cfg.plugins.entries = cfg.plugins.entries || {}
if (!cfg.plugins.entries['liangce-ingress']) {
  const secret = (fs.readFileSync(path.join(ROOT,'.env'),'utf8').match(/^OPENCLAW_LIANGCE_HANDOFF_SECRET=(.+)$/m)||[])[1]?.trim()
  cfg.plugins.entries['liangce-ingress'] = { enabled: true, config: { handoffSecret: secret } }
} else {
  cfg.plugins.entries['liangce-ingress'].enabled = true
}
cfg.plugins.load = cfg.plugins.load || {}
cfg.plugins.load.paths = Array.from(new Set([...(cfg.plugins.load.paths||[]), '/home/node/.openclaw/extensions/liangce-ingress']))
fs.writeFileSync(path.join(tmp,'oc.stable2.json'), JSON.stringify(cfg,null,2))
sh(`docker run --rm -v ${VOL}:/data -v ${tmp.replace(/\\/g,'/')}:/out alpine sh -c "cp /out/oc.stable2.json /data/openclaw.json; chown 1000:1000 /data/openclaw.json; chmod 600 /data/openclaw.json"`)

// Copy good plugin files into volume directly (survive recreate)
sh(`docker run --rm -v ${VOL}:/data -v ${path.join(ROOT,'integrations/openclaw/liangce-ingress').replace(/\\/g,'/')}:/src alpine sh -c "mkdir -p /data/extensions/liangce-ingress; cp /src/index.js /src/package.json /src/openclaw.plugin.json /data/extensions/liangce-ingress/; chown -R 1000:1000 /data/extensions/liangce-ingress"`)

sh('docker compose up -d openclaw-gateway')
for (let i=0;i<20;i++){
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000)
  let out=''
  try { out = execSync('docker ps -a --filter name=openclaw-gateway --format "{{.Names}} {{.Status}}"',{encoding:'utf8'}) } catch {}
  console.log('tick', i, out.trim())
  if (out.includes('healthy')) break
}
