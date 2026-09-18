const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const ROOT = 'D:\\mind-map'
const VOL = 'mind-map_mind-map-openclaw'
const tmp = path.join(ROOT, '.tmp')
function sh(c){ console.log('>>', c); return execSync(c,{encoding:'utf8',cwd:ROOT,windowsHide:true}) }

// Disable plugin to stabilize
const cfg = JSON.parse(fs.readFileSync(path.join(tmp,'openclaw.last-good.json'),'utf8'))
if (cfg.plugins?.entries?.['liangce-ingress']) {
  cfg.plugins.entries['liangce-ingress'].enabled = false
}
if (cfg.plugins?.load?.paths) {
  cfg.plugins.load.paths = cfg.plugins.load.paths.filter(p => !String(p).includes('liangce-ingress'))
  if (!cfg.plugins.load.paths.length) delete cfg.plugins.load
}
fs.writeFileSync(path.join(tmp,'openclaw.stable.json'), JSON.stringify(cfg, null, 2))
sh(`docker run --rm -v ${VOL}:/data -v ${tmp.replace(/\\/g,'/')}:/out alpine sh -c "cp /out/openclaw.stable.json /data/openclaw.json; chown 1000:1000 /data/openclaw.json; chmod 600 /data/openclaw.json; echo STABLE_OK"`)
sh('docker compose restart openclaw-gateway')
