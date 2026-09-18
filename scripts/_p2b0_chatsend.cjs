const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:8e6})}catch(e){return String(e.stdout||e.stderr||e)}}
// Find chat.send handler params
console.log(sh(`docker exec ${c} sh -c "grep -R -n -E 'chat\\\\.send|\\\"chat.send\\\"' /app/dist/*.mjs 2>/dev/null | head -30"`));
console.log('--- method schema ---');
console.log(sh(`docker exec ${c} sh -c "grep -R -n 'chat.send' /app/dist/gateway*.mjs /app/dist/server*.mjs /app/dist/*protocol* 2>/dev/null | head -40"`));
console.log('--- sender in chat send payload ---');
console.log(sh(`docker exec ${c} sh -c "grep -R -n -E 'senderId|requesterSenderId|messageChannel' /app/dist/*chat* 2>/dev/null | head -40"`));
console.log('--- gateway client chat.send ---');
console.log(sh(`docker exec ${c} sh -c "grep -R -n 'chat.send' /app/node_modules/@openclaw/gateway-client 2>/dev/null | head -20; ls /app/node_modules/@openclaw 2>/dev/null | head"`));
