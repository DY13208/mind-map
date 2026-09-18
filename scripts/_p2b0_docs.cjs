const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:10e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// Extract MCP resolver docs
console.log('=== sdk-overview MCP resolver ===');
console.log(sh(`docker exec ${c} sh -c "sed -n '360,450p' /app/docs/plugins/sdk-overview.md"`));
console.log('=== architecture trusted requester ===');
console.log(sh(`docker exec ${c} sh -c "sed -n '180,250p' /app/docs/plugins/architecture.md"`));
console.log('=== building-plugins requesterSenderId ===');
console.log(sh(`docker exec ${c} sh -c "grep -n -A8 -B8 requesterSenderId /app/docs/plugins/building-plugins.md | head -80"`));
console.log('=== mcp manager resolve snippet ===');
console.log(sh(`docker exec ${c} sh -c "sed -n '650,850p' /app/dist/agent-bundle-mcp-manager-api-C2f-mfWR.mjs"`));
