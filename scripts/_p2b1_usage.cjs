const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:20e6})}catch(e){return String(e.stdout||e.stderr||e)}}
console.log(sh(`docker exec ${c} sh -c "grep -R -l 'dispatchInboundDirectDmWithRuntime' /app/extensions --include='*.ts' --include='*.js' 2>/dev/null | head -20"`));
console.log(sh(`docker exec ${c} sh -c "grep -R -n -B2 -A30 'dispatchInboundDirectDmWithRuntime' /app/extensions/telegram /app/extensions/feishu /app/extensions/slack 2>/dev/null | head -100"`));
