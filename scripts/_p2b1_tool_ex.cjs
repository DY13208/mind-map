const { execSync } = require('child_process')
const CTR = 'mind-map-openclaw-gateway-1'
function sh(c){ return execSync(c,{encoding:'utf8',windowsHide:true,maxBuffer:8e6}) }
console.log(sh(`docker exec ${CTR} sh -c "grep -R \"registerTool(\" -n /home/node/.openclaw/extensions/cognee-openclaw/dist/*.js 2>/dev/null | head -5"`))
console.log(sh(`docker exec ${CTR} sh -c "grep -R \"name: .who\\|registerTool\" -n /app/dist/extensions --include='*.js' 2>/dev/null | head -30"`))
console.log(sh(`docker exec ${CTR} sh -c "grep -A30 'function registerTool\\|registerTool(tool' /app/docs/plugins/sdk-overview.md | head -40"`))
# look at stock plugin tool example
console.log(sh(`docker exec ${CTR} sh -c "grep -R \"api.registerTool\" -l /app/dist/extensions 2>/dev/null | head -10"`))
console.log(sh(`docker exec ${CTR} sh -c "grep -R \"api.registerTool\" -A25 /app/dist/extensions/device-pair/index.js 2>/dev/null | head -40"`))
