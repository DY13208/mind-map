const fs=require('fs');
const http=require('http');
const crypto=require('crypto');
function loadEnv(){
  const m={};
  for(const line of fs.readFileSync('.env','utf8').split(/\r?\n/)){
    const t=line.trim(); if(!t||t.startsWith('#')) continue;
    const i=t.indexOf('='); if(i<=0) continue;
    let v=t.slice(i+1).trim();
    if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
    m[t.slice(0,i).trim()]=v;
  }
  return m;
}
const env=loadEnv();
const token=env.OPENCLAW_GATEWAY_TOKEN||env.OPENCLAW_TOKEN||'';
const port=Number(env.OPENCLAW_PORT||4623);
if(!token){ console.error('NO_TOKEN'); process.exit(2); }
console.log('token_fp', crypto.createHash('sha256').update(token).digest('hex').slice(0,12));
console.log('port', port);

function postChat(userTag, text){
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({
      model: env.OPENCLAW_MODEL || 'openclaw/default',
      stream: false,
      user: userTag,
      messages: [{ role:'user', content: text }]
    });
    const req=http.request({
      host:'127.0.0.1', port,
      path:'/v1/chat/completions',
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':`Bearer ${token}`,
        'Content-Length':Buffer.byteLength(body)
      },
      timeout: 120000
    }, res=>{
      let d='';
      res.on('data',c=>d+=c);
      res.on('end',()=>resolve({status:res.statusCode, body:d.slice(0,1500)}));
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy(); reject(new Error('timeout'));});
    req.write(body); req.end();
  });
}

(async()=>{
  const a='conv:p2b0-userA-'+Date.now();
  const b='conv:p2b0-userB-'+Date.now();
  console.log('A_tag', a);
  console.log('B_tag', b);
  // fire concurrently
  const [ra,rb]=await Promise.all([
    postChat(a, 'Phase2B-0 identity probe USER_A. Reply with exactly: ACK_A'),
    postChat(b, 'Phase2B-0 identity probe USER_B. Reply with exactly: ACK_B')
  ]);
  console.log('A_status', ra.status);
  console.log('A_body', ra.body);
  console.log('B_status', rb.status);
  console.log('B_body', rb.body);
  fs.writeFileSync('integrations/openclaw/phase2b0/live-dual-http.json', JSON.stringify({a:{tag:a,...ra},b:{tag:b,...rb}},null,2));
})().catch(e=>{ console.error('FAIL', e); process.exit(1); });
