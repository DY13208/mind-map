const {execSync}=require('child_process');
function sh(cmd){try{return execSync(cmd,{encoding:'utf8'})}catch(e){return (e.stdout||'')+(e.stderr||'')+String(e)}}
const name='mind-map-openclaw-gateway-1';
console.log('=== version files ===');
console.log(sh(`docker exec ${name} sh -c "ls -la /app/package.json /home/node/app/package.json /openclaw/package.json 2>/dev/null; find / -name package.json -path '*openclaw*' 2>/dev/null | head -20"`));
console.log('=== package version ===');
console.log(sh(`docker exec ${name} sh -c "cat /app/package.json 2>/dev/null | head -30; cat /home/node/.openclaw/package.json 2>/dev/null | head -20; openclaw --version 2>&1; node /app/dist/index.js --version 2>&1 | head -5"`));
console.log('=== env identity-ish ===');
console.log(sh(`docker exec ${name} sh -c "env | sort | grep -iE 'USER|SENDER|REQUEST|SESSION|TOKEN|MCP|AUTH|WECOM|AGENT' | sed 's/=.*/=***/'"`));
