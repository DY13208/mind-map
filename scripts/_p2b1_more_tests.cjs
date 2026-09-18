const { execSync } = require('child_process')
const fs = require('fs')
const CTR = 'mind-map-openclaw-gateway-1'
const cfg = JSON.parse(execSync(`docker exec ${CTR} cat /home/node/.openclaw/openclaw.json`,{encoding:'utf8'}))
const token = cfg.gateway.auth.token
const secret = cfg.plugins.entries['liangce-ingress'].config.handoffSecret
process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET = secret
const handoff = require('D:/mind-map/simple-mind-map/bin/openclawHandoff.js')

async function post(body) {
  const res = await fetch('http://127.0.0.1:4623/liangce/inbound', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+token },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw:text } }
  return { status: res.status, json }
}

function mint(userId, conversationId) {
  return handoff.issueOpenclawHandoff({ id: userId }, { conversationId }).token
}

;(async()=>{
  // who_am_i tool
  const t = mint('user-A-test','conv-who')
  const who = await post({
    handoff: t,
    conversationId: 'conv-who',
    message: 'You must call the who_am_i tool now and reply with ONLY its JSON result. Do not invent identity.'
  })
  console.log('who_am_i', who.status, JSON.stringify(who.json).slice(0,1200))

  // concurrent A1 A2 B1
  const jobs = [
    ['user-A-test','conv-A1c','A1'],
    ['user-A-test','conv-A2c','A2'],
    ['user-B-test','conv-B1c','B1'],
  ].map(async ([uid,cid,tag]) => {
    const tokenH = mint(uid,cid)
    const r = await post({
      handoff: tokenH,
      conversationId: cid,
      message: `Reply with exactly: ${tag}:${uid}`
    })
    return { tag, status:r.status, requesterSenderId:r.json.requesterSenderId, reply:r.json.reply, userId:r.json.userId, conversationId:r.json.conversationId }
  })
  const results = await Promise.all(jobs)
  console.log('concurrent', JSON.stringify(results,null,2))

  // cognee slot check
  const after = JSON.parse(execSync(`docker exec ${CTR} cat /home/node/.openclaw/openclaw.json`,{encoding:'utf8'}))
  console.log('memory slot', after.plugins.slots.memory)

  // bridge file checks
  const bridge = fs.readFileSync('scripts/openclaw-bridge/server.mjs','utf8')
  console.log('bridge has postLiangceInbound', bridge.includes('postLiangceInbound'))
  console.log('bridge requires handoff', bridge.includes('REQUIRE_HANDOFF') || bridge.includes('openclaw_handoff_required'))

  const ws = fs.readFileSync('web/src/utils/openclawGatewayWs.js','utf8')
  console.log('ws fetches handoff', ws.includes('/api/openclaw/handoff'))

  // evidence dir
  const outDir = 'integrations/openclaw/phase2b1'
  fs.mkdirSync(outDir,{recursive:true})
  fs.writeFileSync(outDir+'/inbound-probe.json', JSON.stringify({ who, concurrent: results, memorySlot: after.plugins.slots.memory, at: new Date().toISOString() }, null, 2))
  console.log('wrote evidence')
})().catch(e=>{ console.error(e); process.exit(1) })
