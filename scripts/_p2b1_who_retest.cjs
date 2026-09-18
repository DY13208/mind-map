const { execSync } = require('child_process')
const CTR = 'mind-map-openclaw-gateway-1'
const cfg = JSON.parse(execSync(`docker exec ${CTR} cat /home/node/.openclaw/openclaw.json`,{encoding:'utf8'}))
const token = cfg.gateway.auth.token
const secret = cfg.plugins.entries['liangce-ingress'].config.handoffSecret
process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET = secret
const handoff = require('D:/mind-map/simple-mind-map/bin/openclawHandoff.js')
const t = handoff.issueOpenclawHandoff({ id:'user-A-test' }, { conversationId:'conv-who2' }).token
;(async()=>{
  const res = await fetch('http://127.0.0.1:4623/liangce/inbound', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+token },
    body: JSON.stringify({
      handoff: t,
      conversationId: 'conv-who2',
      message: 'Call the who_am_i tool now. Reply with ONLY the tool JSON. Do not invent identity.'
    })
  })
  console.log(await res.text())
  console.log('--- doctor ---')
  try { console.log(execSync(`docker exec ${CTR} openclaw plugins doctor 2>&1`,{encoding:'utf8'})) } catch(e){ console.log(e.stdout||e.message) }
})()
