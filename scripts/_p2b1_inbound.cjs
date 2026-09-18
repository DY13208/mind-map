const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:20e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// Find how inbound context sets senderId / From for agent runs
console.log(sh(`docker exec ${c} sh -c "grep -R -n -E 'senderAttribution|RequesterSenderId|senderId:' /app/dist/channel-inbound*.mjs /app/dist/*inbound*envelope* 2>/dev/null | head -40"`));
console.log('\n--- buildInbound ---');
console.log(sh(`docker exec ${c} sh -c "grep -R -n -E 'function buildInbound|createInboundContext|toInboundSender|SenderId' /app/dist/*channel-inbound* 2>/dev/null | head -40"`));
console.log('\n--- registerHttpRoute plugin example ---');
console.log(sh(`docker exec ${c} sh -c "grep -R -n -A25 'registerHttpRoute' /app/docs/plugins/building-plugins.md 2>/dev/null | head -80"`));
console.log('\n--- chat.send params schema for sender ---');
console.log(sh(`docker exec ${c} sh -c "grep -R -n -E 'senderAttribution|ChatSendParams|chatSendSchema' /app/dist/chat-send*.mjs /app/dist/chat-BP*.mjs 2>/dev/null | head -40"`));
