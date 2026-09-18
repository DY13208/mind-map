const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const CTR = 'mind-map-openclaw-gateway-1'
function sh(c){ console.log('>>', c.slice(0,120)); return execSync(c,{encoding:'utf8',windowsHide:true}) }

const probes = [
  "import('openclaw/plugin-sdk/plugin-entry').then(m=>console.log('plugin-entry',Object.keys(m))).catch(e=>console.log('FAIL plugin-entry',e.message))",
  "import('openclaw/plugin-sdk/channel-core').then(m=>console.log('channel-core',Object.keys(m))).catch(e=>console.log('FAIL channel-core',e.message))",
  "import('openclaw/plugin-sdk/channel-inbound').then(m=>console.log('channel-inbound',Object.keys(m))).catch(e=>console.log('FAIL channel-inbound',e.message))",
  "import('openclaw/plugin-sdk').then(m=>console.log('sdk',Object.keys(m).slice(0,30))).catch(e=>console.log('FAIL sdk',e.message))",
]
for (const p of probes) {
  const cmd = `docker exec ${CTR} node --input-type=module -e ${JSON.stringify(p)}`
  try { console.log(sh(cmd)) } catch(e){ console.log(String(e.stdout||e.stderr||e.message)) }
}

// Also list how cognee registers http
console.log(sh(`docker exec ${CTR} sh -c "ls /home/node/.openclaw/extensions; ls /app/dist/extensions 2>/dev/null | head; grep -R registerHttpRoute -l /home/node/.openclaw/extensions/cognee-openclaw/dist 2>/dev/null | head"`))
