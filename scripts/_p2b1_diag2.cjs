const { execSync } = require('child_process')
const CTR = 'mind-map-openclaw-gateway-1'
function sh(c){ try { return execSync(c,{encoding:'utf8',windowsHide:true, maxBuffer:8e6}) } catch(e){ return (e.stdout||'')+(e.stderr||e.message) } }

console.log('==== internal log grep ====')
console.log(sh(`docker exec ${CTR} sh -c "grep -i liangce /tmp/openclaw/*.log 2>/dev/null | tail -40; grep -iE 'plugin.*(error|fail|warn|reject|skip)' /tmp/openclaw/*.log 2>/dev/null | tail -40"`))

console.log('==== plugins cli ====')
console.log(sh(`docker exec ${CTR} sh -c "openclaw plugins --help 2>&1 | head -40"`))
console.log(sh(`docker exec ${CTR} sh -c "openclaw plugins list 2>&1 | head -60"`))

console.log('==== how cognee resolves openclaw imports ====')
console.log(sh(`docker exec ${CTR} sh -c "ls /home/node/.openclaw/extensions/cognee-openclaw/node_modules 2>/dev/null | head; head -5 /home/node/.openclaw/extensions/cognee-openclaw/dist/index.js; node -e \\"console.log(require.resolve('openclaw/package.json'))\\" 2>&1"`))
