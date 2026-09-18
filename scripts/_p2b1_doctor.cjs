const { execSync } = require('child_process')
const CTR = 'mind-map-openclaw-gateway-1'
function sh(c){ try { return execSync(c,{encoding:'utf8',windowsHide:true, maxBuffer:8e6}) } catch(e){ return (e.stdout||'')+(e.stderr||e.message) } }
console.log(sh(`docker exec ${CTR} openclaw plugins doctor 2>&1`))
console.log('==== inspect ====')
console.log(sh(`docker exec ${CTR} openclaw plugins inspect liangce-ingress 2>&1`))
console.log('==== validate ====')
console.log(sh(`docker exec ${CTR} openclaw plugins validate liangce-ingress 2>&1`))
