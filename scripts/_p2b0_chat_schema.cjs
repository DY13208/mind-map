const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:5e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// How chat.send / sessions encode sender
console.log('=== chat.send schema ===');
console.log(sh(`docker exec ${c} sh -c "grep -R -n -E 'chat.send|sessionKey|senderId|requesterSenderId' /app/docs/gateway 2>/dev/null | head -60"`));
console.log(sh(`docker exec ${c} sh -c "grep -R -n 'chat.send' /app/docs 2>/dev/null | head -40"`));
console.log('=== sessions key format ===');
console.log(sh(`docker exec ${c} sh -c "grep -R -n -E 'sessionKey|main:' /app/docs/concepts /app/docs/gateway 2>/dev/null | head -50"`));
console.log('=== cron no requester ===');
console.log(sh(`docker exec ${c} sh -c "grep -R -n -E 'requesterSenderId|cron|heartbeat|subagent' /app/docs/plugins/sdk-overview.md 2>/dev/null | head -40"`));
