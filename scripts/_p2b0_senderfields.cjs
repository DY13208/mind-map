const {execSync}=require('child_process');
const c='mind-map-openclaw-gateway-1';
function sh(x){try{return execSync(x,{encoding:'utf8',maxBuffer:8e6})}catch(e){return String(e.stdout||e.stderr||e)}}
console.log('=== operator-role gatewayClientSenderFields ===');
console.log(sh(`docker exec ${c} sh -c "grep -n -E 'gatewayClientSenderFields|SenderFields|requesterSenderId|senderId' /app/dist/operator-role*.mjs | head -60"`));
const file=sh(`docker exec ${c} sh -c "ls /app/dist/operator-role*.mjs"`).trim().split(/\s+/).filter(Boolean)[0];
console.log('file',file);
console.log(sh(`docker exec ${c} sh -c "grep -n -E 'function gatewayClientSenderFields|gatewayClientSenderFields|requesterSenderId|senderId|client.mode|backend' ${file} | head -80"`));
// Extract function body roughly
console.log(sh(`docker exec ${c} sh -c "python3 - <<'PY'
import re
p='${file}'
t=open(p,encoding='utf-8',errors='ignore').read()
for name in ['gatewayClientSenderFields','resolveChatSendCallerContext']:
  i=t.find(name)
  print('---',name,'at',i)
  print(t[i:i+2500] if i>=0 else 'missing')
PY"`));
