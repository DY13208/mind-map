const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:20e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// Find simplest plugin with HTTP inbound + dispatch
console.log(sh(`docker exec ${c} sh -c "grep -R -l 'registerHttpHandler\\|registerHttpRoute' /app/extensions --include='*.ts' 2>/dev/null | head -20"`));
console.log('\n--- dispatchInboundDirectDm export ---');
console.log(sh(`docker exec ${c} sh -c "grep -R -n 'dispatchInboundDirectDm' /app/dist/plugin-sdk /app/node_modules/openclaw/dist/plugin-sdk 2>/dev/null | head -30"`));
console.log('\n--- runChannelInboundEvent ---');
console.log(sh(`docker exec ${c} sh -c "grep -R -n 'runChannelInboundEvent\\|finalizeInboundContext' /app/docs/plugins/sdk-channel-plugins.md 2>/dev/null | head -40"`));
console.log('\n--- plugin http webhook example wecom ---');
console.log(sh(`docker exec ${c} sh -c "grep -n -A30 -E 'registerHttp|webhook' /app/extensions/wecom/index.ts 2>/dev/null | head -80"`));
