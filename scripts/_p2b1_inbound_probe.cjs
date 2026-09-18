const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')
const ROOT = 'D:\\mind-map'
const CTR = 'mind-map-openclaw-gateway-1'

// Read gateway token + secret from config/.env
const cfg = JSON.parse(execSync(`docker exec ${CTR} cat /home/node/.openclaw/openclaw.json`,{encoding:'utf8'}))
const token = cfg.gateway.auth.token
const secret = cfg.plugins.entries['liangce-ingress'].config.handoffSecret
console.log({ tokenLen: token.length, secretLen: (secret||'').length })

// Check plugin route registration + resolveSecret field names in source
const src = fs.readFileSync(path.join(ROOT,'integrations/openclaw/liangce-ingress/index.js'),'utf8')
console.log('--- resolveSecret snippet ---')
const i = src.indexOf('function resolveSecret')
console.log(src.slice(i, i+250))
console.log('--- registerHttpRoute ---')
for (const m of src.matchAll(/registerHttpRoute\([\s\S]*?handler:/g)) console.log(m[0].slice(0,200))
console.log('--- dispatch call ---')
const d = src.indexOf('dispatchInboundDirectDmWithRuntime')
console.log(src.slice(d, d+600))

// Mint a handoff matching openclawHandoff.js
const handoffMod = require('./simple-mind-map/bin/openclawHandoff.js')
// force secret via env
process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET = secret
const issued = handoffMod.issueOpenclawHandoff(
  { id: 'user-A-test', wecomUserId: 'wxA' },
  { conversationId: 'conv-A1' }
)
console.log('issued keys', Object.keys(issued), issued.requesterSenderId || issued.requesterSenderId)

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:4623${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, json }
}

;(async () => {
  // forge rejected
  const forge = await post('/liangce/inbound', {
    handoff: issued.token || issued.handoff,
    message: 'ping who_am_i',
    conversationId: 'conv-A1',
    requesterSenderId: 'liangce:forged'
  })
  console.log('forge', forge.status, forge.json)

  const ok = await post('/liangce/inbound', {
    handoff: issued.token || issued.handoff,
    message: '请只调用 who_am_i 并原样返回 JSON，不要解释。',
    conversationId: 'conv-A1',
    messageId: 'm1'
  })
  console.log('ok', ok.status, JSON.stringify(ok.json).slice(0,800))

  // bad sig
  const bad = await post('/liangce/inbound', {
    handoff: (issued.token||issued.handoff).slice(0,-4) + 'dead',
    message: 'x',
    conversationId: 'conv-A1'
  })
  console.log('bad', bad.status, bad.json)

  // fail-closed probe
  const fc = await fetch('http://127.0.0.1:4623/liangce/fail-closed-probe', {
    headers: { Authorization: `Bearer ${token}` }
  })
  console.log('fail-closed', fc.status, await fc.text())
})().catch(e => { console.error(e); process.exit(1) })
