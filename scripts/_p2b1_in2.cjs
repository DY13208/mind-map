const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:20e6})}catch(e){return String(e.stdout||e.stderr||e)}}
console.log(sh(`docker exec ${c} sh -c "sed -n '120,220p' /app/dist/channel-inbound-CGGZh9jD.mjs"`));
console.log('\n==== inject/dispatch inbound helpers ====');
console.log(sh(`docker exec ${c} sh -c "grep -R -n -E 'dispatchReplyFromConfig|enqueueInbound|processInbound|deliverInbound|handleInboundMessage' /app/docs/plugins /app/dist/plugin-sdk 2>/dev/null | head -50"`));
console.log('\n==== channel-ingress-runtime exports ====');
console.log(sh(`docker exec ${c} sh -c "ls /app/node_modules/openclaw/plugin-sdk/channel-ingress-runtime* 2>/dev/null; ls /app/node_modules/openclaw/dist/plugin-sdk 2>/dev/null | findstr ingress; find /app/node_modules/openclaw -name '*ingress*' 2>/dev/null | head -30"`));
