const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
const cmd=`docker exec ${c} sh -c "grep -R -n registerMcpServerConnectionResolver /app/docs/plugins/sdk-overview.md /app/dist/plugin-sdk/*.d.ts 2>/dev/null | head -20"`;
console.log(execSync(cmd,{encoding:'utf8'}));
const cmd2=`docker exec ${c} sh -c "grep -n 'registerMcpServerConnectionResolver\\|registerTool\\|registerHttpRoute\\|registerChannel' /app/dist/plugin-sdk/plugin-entry.js | head -40"`;
console.log(execSync(cmd2,{encoding:'utf8'}));
# look at OpenClawPluginApi type
const cmd3=`docker exec ${c} sh -c "grep -R -n 'registerMcpServerConnectionResolver' /app/dist --include='*.d.ts' 2>/dev/null | head -15"`;
console.log(execSync(cmd3,{encoding:'utf8'}));
