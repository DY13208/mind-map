const { execSync } = require('child_process')
const CTR = 'mind-map-openclaw-gateway-1'
function sh(c){ try { return execSync(c,{encoding:'utf8',windowsHide:true,maxBuffer:8e6}) } catch(e){ return (e.stdout||'')+(e.stderr||e.message) } }
console.log(sh(`docker exec ${CTR} sh -c "grep -n -A35 'api.registerTool' /app/dist/extensions/file-transfer/index.js | head -80"`))
console.log('====')
console.log(sh(`docker exec ${CTR} sh -c "grep -n -A40 'api.registerTool' /app/dist/extensions/memory-wiki/index.js | head -90"`))
console.log('==== current plugin tool block ====')
const fs=require('fs')
const src=fs.readFileSync('integrations/openclaw/liangce-ingress/index.js','utf8')
const i=src.indexOf('registerTool')
console.log(src.slice(i-80, i+700))
