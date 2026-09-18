const {execSync}=require('child_process');
const name='mind-map-openclaw-gateway-1';
function sh(c){try{return execSync(c,{encoding:'utf8',maxBuffer:20e6})}catch(e){return (e.stdout||'')+(e.stderr||'')}}
console.log('=== ripgrep in /app for requester/sender/mcp resolver ===');
console.log(sh(`docker exec ${name} sh -c "grep -R -n -E 'requesterSenderId|requester-scoped|requesterScoped|senderId|connectionResolver|mcp.*resolver|per-requester|trustedRequester' /app/dist /app/docs /app/extensions 2>/dev/null | head -80"`));
console.log('=== openclaw help mcp ===');
console.log(sh(`docker exec ${name} sh -c "openclaw mcp --help 2>&1 | head -60; openclaw plugins --help 2>&1 | head -40"`));
console.log('=== config keys (redacted) ===');
console.log(sh(`docker exec ${name} sh -c "node -e \\"const fs=require('fs'); const p='/home/node/.openclaw/openclaw.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); const walk=(o,pref='')=>{ if(!o||typeof o!=='object')return; for(const k of Object.keys(o)){ const path=pref?pref+'.'+k:k; const v=o[k]; if(v&&typeof v==='object'&&!Array.isArray(v)) walk(v,path); else if(Array.isArray(v)) console.log(path+' = [array '+v.length+']'); else console.log(path+' = '+ (String(k).toLowerCase().match(/token|key|secret|password/) ? '***' : JSON.stringify(v))); }} ; walk(j)\\""`));
