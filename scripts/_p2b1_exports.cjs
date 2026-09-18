const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:10e6})}catch(e){return String(e.stdout||e.stderr||e)}}
console.log('=== plugin-entry ===');
console.log(sh(`docker exec ${c} sh -c "ls /app/dist/plugin-sdk | grep -E 'plugin-entry|channel-core|channel-inbound' "`));
console.log(sh(`docker exec ${c} sh -c "node --input-type=module -e \\"import * as pe from 'openclaw/plugin-sdk/plugin-entry'; console.log(Object.keys(pe).join(','))\\""`));
console.log(sh(`docker exec ${c} sh -c "node --input-type=module -e \\"import * as pe from 'openclaw/plugin-sdk/channel-core'; console.log(Object.keys(pe).join(','))\\""`));
console.log(sh(`docker exec ${c} sh -c "node --input-type=module -e \\"import * as pe from 'openclaw/plugin-sdk/channel-inbound'; console.log(Object.keys(pe).filter(k=>/dispatch|Inbound|Dm|Direct/i.test(k)).join(','))\\""`));
