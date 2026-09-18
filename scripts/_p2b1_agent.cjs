const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:20e6})}catch(e){return String(e.stdout||e.stderr||e)}}
console.log(sh(`docker exec ${c} sh -c "grep -n -E 'senderId|requesterSenderId|SenderId' /app/dist/agent-run*.mjs /app/dist/*agent-rpc* 2>/dev/null | head -40"`));
console.log('\n--- agent method params ---');
console.log(sh(`docker exec ${c} sh -c "grep -n -A40 'agent\\\\.run\\|\\\"agent\\\"' /app/dist/method-scopes*.mjs 2>/dev/null | head -20; grep -R -n 'validateAgentParams\\|AgentParams' /app/dist/src-*.mjs 2>/dev/null | head -20"`));
console.log('\n--- beam inbound ---');
console.log(sh(`docker exec ${c} sh -c "sed -n '1,160p' /app/extensions/beam/index.ts"`));
