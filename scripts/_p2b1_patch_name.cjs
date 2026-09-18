const fs = require('fs')
const { execSync } = require('child_process')
const p = 'D:/mind-map/integrations/openclaw/liangce-ingress/index.js'
let s = fs.readFileSync(p,'utf8')
if (!s.includes('{ name: "who_am_i" }')) {
  s = s.replace('{ optional: true },', '{ name: "who_am_i" },')
  fs.writeFileSync(p,s)
  console.log('patched optional->name')
} else {
  console.log('already named')
}
// wait healthy
function sleep(ms){ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms) }
let ok=false
for (let i=0;i<25;i++){
  sleep(3000)
  let h=''
  try { h=execSync('docker inspect --format "{{.State.Health.Status}}" mind-map-openclaw-gateway-1',{encoding:'utf8'}).trim() } catch {}
  console.log(i,h)
  if (h==='healthy'){ ok=true; break }
  if (h==='unhealthy') break
}
if (!ok) { console.log('not healthy'); process.exit(1) }
execSync('docker cp "D:/mind-map/integrations/openclaw/liangce-ingress/index.js" mind-map-openclaw-gateway-1:/home/node/.openclaw/extensions/liangce-ingress/index.js')
// hot reload may need restart for tool opts
execSync('docker restart mind-map-openclaw-gateway-1')
ok=false
for (let i=0;i<25;i++){
  sleep(3000)
  let h=''
  try { h=execSync('docker inspect --format "{{.State.Health.Status}}" mind-map-openclaw-gateway-1',{encoding:'utf8'}).trim() } catch {}
  console.log('r',i,h)
  if (h==='healthy'){ ok=true; break }
}
console.log('final', ok)
