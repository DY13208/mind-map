const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:30e6})}catch(e){return String(e.stdout||e.stderr||e)}}
const cmds=[
 `docker exec ${c} sh -c "grep -R -l -E 'requesterSenderId|RequesterSender|requester_sender' /app 2>/dev/null | head -40"`,
 `docker exec ${c} sh -c "grep -R -n -E 'requesterSenderId' /app/dist /app/docs 2>/dev/null | head -40"`,
 `docker exec ${c} sh -c "grep -R -n -E 'senderId|SenderId' /app/docs 2>/dev/null | head -40"`,
 `docker exec ${c} sh -c "grep -R -n -E 'scopedMcp|mcpResolver|connectionResolver|perRequester|per-requester|requesterScoped' /app/docs /app/dist 2>/dev/null | head -50"`,
 `docker exec ${c} sh -c "ls /app/docs 2>/dev/null | head -40; ls /app/docs/mcp 2>/dev/null; ls /app/docs/gateway 2>/dev/null | head -40"`,
 `docker exec ${c} sh -c "grep -R -n -E 'sessionKey|chat.send' /app/docs 2>/dev/null | head -40"`,
];
for(const cmd of cmds){ console.log('\n## '+cmd.slice(0,120)); console.log(sh(cmd)); }
