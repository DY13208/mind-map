const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:10e6})}catch(e){return String(e.stdout||e.stderr||e)}}
const db='/home/node/.openclaw/agents/main/openclaw.sqlite';
console.log(sh(`docker exec ${c} sh -c "command -v sqlite3; ls -la ${db}*"`));
console.log('=== tables ===');
console.log(sh(`docker exec ${c} sqlite3 ${db} ".tables"`));
console.log('=== schema sample ===');
console.log(sh(`docker exec ${c} sqlite3 ${db} ".schema" | head -120`));
