const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:8e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// Print dispatchInboundDirectDmWithRuntime param usages near definition
console.log(sh(`docker exec ${c} sh -c "sed -n '127,200p' /app/dist/channel-inbound-CGGZh9jD.mjs"`));
console.log('--- createChatChannelPlugin ---');
console.log(sh(`docker exec ${c} sh -c "grep -n 'function createChatChannelPlugin' /app/dist/plugin-sdk/channel-core.js /app/dist/*channel-plugin* 2>/dev/null | head -10"`));
