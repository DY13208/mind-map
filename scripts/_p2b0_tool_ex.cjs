const {execSync}=require('child_process');
function sh(c){try{return execSync(c,{encoding:'utf8',maxBuffer:5e6})}catch(e){return String(e.stdout||e.stderr||e)}}
console.log(sh(`docker exec mind-map-openclaw-gateway-1 sh -c "grep -R -l registerTool /app/extensions --include='*.ts' --include='*.js' 2>/dev/null | head -15"`));
console.log(sh(`docker exec mind-map-openclaw-gateway-1 sh -c "grep -R -n -A30 'registerTool(' /app/extensions/phone-control 2>/dev/null | head -80"`));
console.log(sh(`docker exec mind-map-openclaw-gateway-1 sh -c "ls /app/extensions | head -40"`));
console.log(sh(`docker exec mind-map-openclaw-gateway-1 sh -c "grep -R -n -A40 'registerMcpServerConnectionResolver' /app/extensions /app/docs 2>/dev/null | head -100"`));
