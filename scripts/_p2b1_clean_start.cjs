const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const ROOT = 'D:\\mind-map'
const VOL = 'mind-map_mind-map-openclaw'
const tmp = path.join(ROOT, '.tmp')
function sh(c, opts={}) {
  console.log('>>', c)
  try { return execSync(c, { encoding:'utf8', cwd:ROOT, windowsHide:true, ...opts }) }
  catch (e) { console.log(String(e.stdout||'')); console.log(String(e.stderr||e.message)); return '' }
}

// Remove plugin files from volume
sh(`docker run --rm -v ${VOL}:/data -v ${tmp.replace(/\\/g,'/')}:/out alpine sh -c "rm -rf /data/extensions/liangce-ingress; ls -la /data/extensions; cp /data/openclaw.json /out/openclaw.now.json"`)

let cfg = JSON.parse(fs.readFileSync(path.join(tmp,'openclaw.now.json'),'utf8'))
console.log('plugins before', JSON.stringify(cfg.plugins,null,2))
if (!cfg.plugins) cfg.plugins = {}
if (!cfg.plugins.entries) cfg.plugins.entries = {}
delete cfg.plugins.entries['liangce-ingress']
if (cfg.plugins.load) delete cfg.plugins.load
if (!cfg.plugins.slots) cfg.plugins.slots = {}
cfg.plugins.slots.memory = 'cognee-openclaw'
fs.writeFileSync(path.join(tmp,'openclaw.clean.json'), JSON.stringify(cfg,null,2))
sh(`docker run --rm -v ${VOL}:/data -v ${tmp.replace(/\\/g,'/')}:/out alpine sh -c "cp /out/openclaw.clean.json /data/openclaw.json; chown 1000:1000 /data/openclaw.json; chmod 600 /data/openclaw.json; wc -c /data/openclaw.json"`)

sh('docker compose up -d --force-recreate openclaw-gateway')
for (let i=0;i<20;i++) {
  const out = sh('docker ps -a --filter name=openclaw-gateway --format "{{.Names}} {{.Status}}"')
  console.log('tick', i, out.trim())
  if (out.includes('healthy')) break
  if (out.includes('Exited') || out.includes('unhealthy')) {
    console.log(sh('docker compose logs openclaw-gateway --tail 100 --no-color'))
    break
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)
}
