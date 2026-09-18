const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:12e6})}catch(e){return String(e.stdout||e.stderr||e)}}
const cmds=[
`docker exec ${c} sh -c "grep -R -n -E 'registerChannel|defineChannel|ChannelPlugin|inbound.*sender|trustedInbound' /app/docs/plugins /app/docs/channels 2>/dev/null | head -80"`,
`docker exec ${c} sh -c "grep -R -n -E 'requesterSenderId|senderAttribution|authenticatedUserId' /app/docs/plugins/sdk-overview.md /app/docs/plugins/architecture.md /app/docs/channels 2>/dev/null | head -60"`,
`docker exec ${c} sh -c "ls /app/docs/channels 2>/dev/null; ls /app/docs/plugins 2>/dev/null | head"`,
`docker exec ${c} sh -c "grep -R -n -E 'custom channel|channel plugin|inbound' /app/docs/channels/*.md 2>/dev/null | head -40"`,
];
for(const cmd of cmds){ console.log('\n####'); console.log(sh(cmd).slice(0,8000)); }
