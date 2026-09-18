const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:8e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// Dump handleDirectExternalChatSend and surrounding requester wiring
console.log(sh(`docker exec ${c} sh -c "sed -n '1180,1450p' /app/dist/chat-BP_OewBT.mjs"`));
console.log('==== handler file requester ====');
console.log(sh(`docker exec ${c} sh -c "grep -n -E 'requesterSenderId|senderId|trusted|external|operator|sessionKey' /app/dist/chat-send-handler-kZQfUabO.mjs | head -80"`));
