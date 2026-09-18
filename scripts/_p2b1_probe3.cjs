const { execSync } = require('child_process')
const CTR = 'mind-map-openclaw-gateway-1'
const cfg = JSON.parse(execSync(`docker exec ${CTR} cat /home/node/.openclaw/openclaw.json`,{encoding:'utf8'}))
const token = cfg.gateway.auth.token
const secret = cfg.plugins.entries['liangce-ingress'].config.handoffSecret
process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET = secret

const handoff = require('D:/mind-map/simple-mind-map/bin/openclawHandoff.js')
const issued = handoff.issueOpenclawHandoff(
  { id: 'user-A-test', wecomUserId: 'wxA' },
  { conversationId: 'conv-A1' }
)
console.log('issued', issued)

async function post(p, body) {
  const res = await fetch('http://127.0.0.1:4623' + p, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, json }
}

;(async()=>{
  console.log('forge', await post('/liangce/inbound', {
    handoff: issued.token, message:'x', conversationId:'conv-A1', requesterSenderId:'liangce:forged'
  }))
  console.log('ok', await post('/liangce/inbound', {
    handoff: issued.token,
    message: 'Reply with only the word PONG.',
    conversationId: 'conv-A1',
    messageId: 'm1'
  }))
  console.log('replay', await post('/liangce/inbound', {
    handoff: issued.token, message:'again', conversationId:'conv-A1'
  }))
  const issued2 = handoff.issueOpenclawHandoff({ id:'user-B-test' }, { conversationId:'conv-B1' })
  console.log('userB', await post('/liangce/inbound', {
    handoff: issued2.token, message:'Reply with only the word PONG.', conversationId:'conv-B1'
  }))
  const sameUserConv2 = handoff.issueOpenclawHandoff({ id:'user-A-test' }, { conversationId:'conv-A2' })
  console.log('sameUser other conv', await post('/liangce/inbound', {
    handoff: sameUserConv2.token, message:'Reply with only the word PONG.', conversationId:'conv-A2'
  }))
  const fc = await fetch('http://127.0.0.1:4623/liangce/fail-closed-probe', { headers:{ Authorization:'Bearer '+token }})
  console.log('fail-closed', fc.status, await fc.text())
})().catch(e=>{ console.error(e); process.exit(1) })
