const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:20e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// Extract AgentParamsSchema definition
console.log(sh(`docker exec ${c} sh -c "grep -n 'AgentParamsSchema' /app/dist/src-CxpZ9eYs.mjs | head -10"`));
console.log(sh(`docker exec ${c} sh -c "sed -n '2277,2360p' /app/dist/src-CxpZ9eYs.mjs"`));
console.log('\n=== how agent method uses sender ===');
console.log(sh(`docker exec ${c} sh -c "grep -n -E 'senderId|From|requester' /app/dist/server-methods-agent*.mjs 2>/dev/null | head -40; ls /app/dist/*agent*method* 2>/dev/null | head"`));
