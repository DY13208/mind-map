const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
const cmd = `docker exec ${c} node --input-type=module -e "import * as pe from 'openclaw/plugin-sdk/channel-inbound'; console.log(Object.keys(pe).sort().join('\\n'))"`;
console.log(execSync(cmd,{encoding:'utf8'}));
