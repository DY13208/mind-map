const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const ROOT = 'D:\\mind-map'
const VOL = 'mind-map_mind-map-openclaw'
function sh(c){ console.log('>>', c); return execSync(c,{encoding:'utf8',cwd:ROOT,windowsHide:true}) }

// 1) Pull last-good and current via alpine
const tmp = path.join(ROOT, '.tmp')
fs.mkdirSync(tmp, {recursive:true})
sh(`docker run --rm -v ${VOL}:/data -v ${tmp.replace(/\\/g,'/')}:/out alpine sh -c "cp /data/openclaw.json.last-good /out/openclaw.last-good.json; cp /data/openclaw.json /out/openclaw.broken.json; ls -la /data/extensions; ls -la /data/extensions/liangce-ingress 2>/dev/null || true"`)

const lastGood = JSON.parse(fs.readFileSync(path.join(tmp,'openclaw.last-good.json'),'utf8'))
const broken = JSON.parse(fs.readFileSync(path.join(tmp,'openclaw.broken.json'),'utf8'))
console.log('last-good plugins', JSON.stringify(lastGood.plugins, null, 2))
console.log('broken load.paths', broken.plugins && broken.plugins.load)

// 2) Restore last-good (known working, no liangce) THEN we'll add plugin more carefully
fs.writeFileSync(path.join(tmp,'openclaw.restore.json'), JSON.stringify(lastGood, null, 2))
sh(`docker run --rm -v ${VOL}:/data -v ${tmp.replace(/\\/g,'/')}:/out alpine sh -c "cp /out/openclaw.restore.json /data/openclaw.json; chown 1000:1000 /data/openclaw.json; chmod 600 /data/openclaw.json"`)

// 3) Start gateway
sh('docker compose up -d openclaw-gateway')
console.log('started')
