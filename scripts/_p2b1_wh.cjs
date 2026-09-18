const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:20e6})}catch(e){return String(e.stdout||e.stderr||e)}}
console.log('=== webhooks index ===');
console.log(sh(`docker exec ${c} sh -c "wc -l /app/extensions/webhooks/index.ts; sed -n '1,200p' /app/extensions/webhooks/index.ts"`));
console.log('\n=== webhooks package/plugin json ===');
console.log(sh(`docker exec ${c} sh -c "cat /app/extensions/webhooks/openclaw.plugin.json; echo ---; cat /app/extensions/webhooks/package.json"`));
