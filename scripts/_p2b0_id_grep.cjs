const fs=require('fs');
const files=[
  'scripts/openclaw-bridge/server.mjs',
  'web/src/utils/openclawChat.js',
  'web/src/utils/openclawGatewayWs.js',
  'web/src/utils/wecomLogin.js',
  'web/src/pages/ProductShell/AssistantPage.vue'
];
for(const f of files){
  console.log('\n\n======== '+f+' ========');
  const t=fs.readFileSync(f,'utf8');
  console.log('LEN',t.length);
  // print identity-relevant lines with context
  const lines=t.split(/\r?\n/);
  const re=/userId|user_id|wecom|sender|session|requester|identity|token|auth|conversation|agentId|channel|header|meta|context|OPENCLAW|bridge|whoami|who_am_i/i;
  lines.forEach((l,i)=>{ if(re.test(l)) console.log(String(i+1).padStart(5)+': '+l); });
}
