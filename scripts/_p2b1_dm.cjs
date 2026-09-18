const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:20e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// Find function dispatchInboundDirectDmWithRuntime definition
console.log(sh(`docker exec ${c} sh -c "grep -n 'function dispatchInboundDirectDmWithRuntime\\|async function dispatchInboundDirectDm' /app/dist/channel-inbound-CGGZh9jD.mjs"`));
console.log(sh(`docker exec ${c} sh -c "grep -n 'dispatchInboundDirectDmWithRuntime' /app/dist/channel-inbound-CGGZh9jD.mjs | head"`));
// print the function - search around first match of async function dispatchInboundDirectDm(
const n=sh(`docker exec ${c} sh -c "grep -n 'async function dispatchInboundDirectDm' /app/dist/channel-inbound-CGGZh9jD.mjs"`);
console.log('lines', n);
const start=parseInt(String(n).split(':')[0],10)||1;
console.log(sh(`docker exec ${c} sh -c "sed -n '${start},${start+80}p' /app/dist/channel-inbound-CGGZh9jD.mjs"`));
// Also check createTestIdentity
