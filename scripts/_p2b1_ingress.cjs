const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:20e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// Pull the experimental ingress section + example channel that sets From/sender
console.log(sh(`docker exec ${c} sed -n '174,260p' /app/docs/plugins/sdk-channel-plugins.md`));
console.log('\n==== channel-ingress package exports ====');
console.log(sh(`docker exec ${c} sh -c "ls /app/node_modules/openclaw/plugin-sdk 2>/dev/null | head; ls /app/dist/plugin-sdk 2>/dev/null | head; find /app -path '*channel-ingress*' -name '*.d.ts' 2>/dev/null | head -20"`));
console.log('\n==== defineChannelPluginEntry example ====');
console.log(sh(`docker exec ${c} sed -n '1090,1220p' /app/docs/plugins/sdk-channel-plugins.md`));
console.log('\n==== qa-channel ====');
console.log(sh(`docker exec ${c} head -150 /app/docs/channels/qa-channel.md`));
