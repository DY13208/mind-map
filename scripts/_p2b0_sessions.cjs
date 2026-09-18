const {execSync}=require('child_process');
const fs=require('fs');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:20e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// Find session files mentioning p2b0-user
console.log(sh(`docker exec ${c} sh -c "grep -R -l 'p2b0-user' /home/node/.openclaw 2>/dev/null | head -40"`));
console.log('==== sessions json keys mentioning p2b0 ====');
console.log(sh(`docker exec ${c} sh -c "grep -R -n 'p2b0-user' /home/node/.openclaw/agents /home/node/.openclaw/sessions /home/node/.openclaw 2>/dev/null | head -60"`));
