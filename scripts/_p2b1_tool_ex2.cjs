const { execSync } = require('child_process')
const CTR = 'mind-map-openclaw-gateway-1'
function sh(c){ try { return execSync(c,{encoding:'utf8',windowsHide:true,maxBuffer:8e6}) } catch(e){ return (e.stdout||'')+(e.stderr||e.message) } }
console.log(sh(`docker exec ${CTR} sh -c "grep -R api.registerTool -l /app/dist/extensions 2>/dev/null | head -15"`))
console.log('---')
console.log(sh(`docker exec ${CTR} sh -c "grep -R api.registerTool -A20 /app/dist/extensions/lobster/index.js 2>/dev/null | head -50"`))
console.log('---')
console.log(sh(`docker exec ${CTR} sh -c "grep -R 'contracts' -n /home/node/.openclaw/extensions/cognee-openclaw/openclaw.plugin.json | head"`))
console.log(sh(`docker exec ${CTR} sh -c "python -c \\"import json;print(json.load(open('/home/node/.openclaw/extensions/cognee-openclaw/openclaw.plugin.json')).get('contracts'))\\" "`))
