const {execSync}=require('child_process');
function sh(c){return execSync(c,{encoding:'utf8'})}
console.log(sh('docker exec mind-map-openclaw-gateway-1 sh -c "ls -la /home/node/.openclaw/extensions 2>/dev/null; ls /app/extensions 2>/dev/null | head"'));
console.log(sh('docker exec mind-map-openclaw-gateway-1 node -e "const j=require(\'/home/node/.openclaw/openclaw.json\'); console.log(JSON.stringify(j.plugins,null,2))"'));
