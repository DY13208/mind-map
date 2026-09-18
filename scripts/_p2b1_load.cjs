const {execSync}=require('child_process');
const fs=require('fs');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:5e6})}catch(e){return String(e.stdout||e.stderr||e)}}
console.log(sh(`docker exec ${c} sh -c "node -e \\"const j=require('/home/node/.openclaw/openclaw.json'); console.log(JSON.stringify({load:j.plugins&&j.plugins.load,entries:Object.keys((j.plugins&&j.plugins.entries)||{}),slots:j.plugins&&j.plugins.slots},null,2))\\""`));
console.log('--- allowlist ---');
console.log(sh(`docker exec ${c} sh -c "grep -n load /home/node/.openclaw/openclaw.json | head -20; ls /home/node/.openclaw/extensions"`));
