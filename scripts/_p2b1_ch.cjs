const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:15e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// Extract how channels set sender / trusted inbound
console.log('=== sdk-channel-plugins sender sections ===');
console.log(sh(`docker exec ${c} sh -c "grep -n -i -E 'sender|requester|inbound|trusted|From|peer' /app/docs/plugins/sdk-channel-plugins.md | head -80"`));
console.log('\n=== feishu inbound example ===');
console.log(sh(`docker exec ${c} sh -c "grep -n -A5 -B2 -E 'senderId|requesterSenderId|SenderId' /app/docs/channels/feishu.md /app/docs/plugins/architecture.md 2>/dev/null | head -60"`));
console.log('\n=== createChatChannelPlugin inbound ===');
console.log(sh(`docker exec ${c} sh -c "grep -n -A40 -E 'inbound|dispatchReply|handleIncoming|normalizeSender' /app/docs/plugins/sdk-channel-plugins.md | head -120"`));
console.log('\n=== qa-channel (test channel?) ===');
console.log(sh(`docker exec ${c} sh -c "head -120 /app/docs/channels/qa-channel.md"`));
