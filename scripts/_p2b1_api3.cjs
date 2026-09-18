const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:5e6})}catch(e){return String(e.stdout||e.stderr||e)}}
console.log(sh(`docker exec ${c} sh -c "grep -R -n registerMcpServerConnectionResolver /app/docs/plugins 2>/dev/null | head -15"`));
console.log(sh(`docker exec ${c} sh -c "grep -R -n 'registerMcpServerConnectionResolver' /app/dist/plugin-sdk 2>/dev/null | head -15"`));
console.log(sh(`docker exec ${c} sh -c "grep -n registerHttpRoute /app/dist/plugin-sdk/*.d.ts 2>/dev/null | head -10"`));
