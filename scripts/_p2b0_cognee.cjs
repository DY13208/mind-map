const fs=require('fs');
const {execSync}=require('child_process');
function sh(x){try{return execSync(x,{encoding:'utf8'})}catch(e){return String(e.stdout||e.stderr||e)}}
const j=JSON.parse(sh('docker exec mind-map-openclaw-gateway-1 cat /home/node/.openclaw/openclaw.json'));
const slots=(j.plugins&&j.plugins.slots)||{};
const mem=slots.memory;
console.log('plugins.slots.memory =', mem);
console.log('cognee enabled?', JSON.stringify(j.plugins?.entries?.['cognee-openclaw'] || j.plugins?.entries?.cognee || Object.keys(j.plugins?.entries||{}).filter(k=>k.toLowerCase().includes('cognee')), null, 2));
