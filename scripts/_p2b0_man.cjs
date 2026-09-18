const {execSync}=require('child_process');
const sh=c=>execSync(c,{encoding:'utf8'});
console.log(sh("docker exec mind-map-openclaw-gateway-1 head -80 /home/node/.openclaw/extensions/cognee-openclaw/openclaw.plugin.json"));
console.log('---');
console.log(sh('docker exec mind-map-openclaw-gateway-1 node -e "const j=require(\'/home/node/.openclaw/openclaw.json\'); console.log(JSON.stringify(j.plugins,null,2).slice(0,2500))"'));
