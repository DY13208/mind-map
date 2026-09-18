const { execSync } = require('child_process')
const CTR = 'mind-map-openclaw-gateway-1'
function sh(c){ try { return execSync(c,{encoding:'utf8',windowsHide:true}) } catch(e){ return (e.stdout||'')+(e.stderr||e.message) } }
console.log('==== logs ====')
console.log(sh(`docker logs ${CTR} 2>&1`).split(/\n/).filter(l=>/liangce|plugin.*fail|plugin.*error|load\.paths|extensions\/liangce|cannot|Error/i.test(l)).slice(-50).join('\n'))
console.log('==== config ====')
console.log(sh(`docker exec ${CTR} cat /home/node/.openclaw/openclaw.json`))
console.log('==== files ====')
console.log(sh(`docker exec ${CTR} ls -la /home/node/.openclaw/extensions/liangce-ingress`))
console.log('==== import ====')
console.log(sh(`docker exec ${CTR} node --input-type=module -e "import('/home/node/.openclaw/extensions/liangce-ingress/index.js').then(m=>console.log('ok',Object.keys(m))).catch(e=>{console.error('ERR',e); process.exitCode=1})"`))
