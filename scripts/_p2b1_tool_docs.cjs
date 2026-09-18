const { execSync } = require('child_process')
const CTR = 'mind-map-openclaw-gateway-1'
function sh(c){ return execSync(c,{encoding:'utf8',windowsHide:true,maxBuffer:5e6}) }
console.log(sh(`docker exec ${CTR} sh -c "grep -n 'registerTool' /app/docs/plugins/sdk-overview.md | head -30"`))
console.log('==== examples ====')
console.log(sh(`docker exec ${CTR} sh -c "grep -A40 'api.registerTool' /app/docs/plugins/sdk-entrypoints.md | head -60"`))
console.log('==== contracts ====')
console.log(sh(`docker exec ${CTR} sh -c "grep -n 'contracts.tools\\|contracts:' /app/docs/plugins/manifest.md | head -40"`))
