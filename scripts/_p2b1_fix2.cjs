const fs=require('fs')
const path=require('path')
const ROOT='D:\\mind-map'
const p=path.join(ROOT,'scripts/openclaw-bridge/server.mjs')
let bridge=fs.readFileSync(p,'utf8')
const start=bridge.indexOf('async function handleChat(ws, msg)')
if(start<0){console.error('no start');process.exit(1)}
// find matching end: next top-level const/function after handleChat's closing brace
// scan braces from start
let i=bridge.indexOf('{', start)
let depth=0
let end=-1
for (; i<bridge.length; i++) {
  const ch=bridge[i]
  if (ch==='{') depth++
  else if (ch==='}') {
    depth--
    if (depth===0) { end=i+1; break }
  }
}
if(end<0){console.error('no end');process.exit(1)}
console.log('replacing', start, end, 'next=', JSON.stringify(bridge.slice(end, end+80)))

const newHandle = `async function handleChat(ws, msg) {
  const chatId = String(msg.id || randomUUID())
  const conversationId = String(msg.conversationId || randomUUID())
  const message = String(msg.message || '').trim()
  const handoff = String(msg.handoff || msg.handoffToken || '').trim()
  if (!message) {
    sendBrowser(ws, { type: 'error', id: chatId, message: '空消息' })
    return
  }
  if (REQUIRE_HANDOFF && !handoff) {
    sendBrowser(ws, {
      type: 'error',
      id: chatId,
      message: '缺少 Signed Handoff（请先 POST /api/openclaw/handoff）',
      code: 'openclaw_handoff_required'
    })
    return
  }

  if (handoff) {
    try {
      const json = await postLiangceInbound({
        handoff,
        message,
        conversationId,
        messageId: chatId
      })
      const reply = String(
        json.reply ||
          (Array.isArray(json.replies) ? json.replies.join('\\n') : '') ||
          ''
      )
      if (reply) sendBrowser(ws, { type: 'delta', id: chatId, text: reply })
      sendBrowser(ws, {
        type: 'done',
        id: chatId,
        text: reply,
        requesterSenderId: json.requesterSenderId || null,
        userId: json.userId || null
      })
      return
    } catch (err) {
      sendBrowser(ws, {
        type: 'error',
        id: chatId,
        message: (err && err.message) || 'liangce inbound failed',
        code: (err && err.code) || 'liangce_inbound_failed'
      })
      return
    }
  }

  try {
    await ensureGateway()
  } catch (err) {
    sendBrowser(ws, {
      type: 'error',
      id: chatId,
      message: (err && err.message) || '无法连接 OpenClaw Gateway'
    })
    return
  }

  const sessionKey = \`main:liangce:\${conversationId}\`
  try {
    const result = await gateway.request(
      'chat.send',
      {
        sessionKey,
        message,
        idempotencyKey: chatId
      },
      { timeoutMs: 120000 }
    )
    const runId = String(
      (result && (result.runId || result.id)) ||
        (result && result.payload && result.payload.runId) ||
        ''
    )
    if (runId) {
      runs.set(runId, { browserWs: ws, chatId, text: '', seq: 0 })
    } else {
      const text = extractAssistantDelta(result) || String(result || '')
      if (text) sendBrowser(ws, { type: 'delta', id: chatId, text })
      sendBrowser(ws, { type: 'done', id: chatId, text })
    }
  } catch (err) {
    try {
      const runId = randomUUID()
      runs.set(runId, { browserWs: ws, chatId, text: '', seq: 0 })
      await gateway.request(
        'agent',
        { sessionKey, message, runId },
        { timeoutMs: 120000 }
      )
    } catch (err2) {
      sendBrowser(ws, {
        type: 'error',
        id: chatId,
        message:
          (err2 && err2.message) ||
          (err && err.message) ||
          'chat.send / agent 调用失败'
      })
    }
  }
}`

bridge = bridge.slice(0, start) + newHandle + bridge.slice(end)

// Align helper to /liangce/inbound
bridge = bridge.replace(/\/liangce\/[a-z-]+/g, (m) => {
  if (m.includes('inbound') || m.includes('inbound')) return '/liangce/inbound'
  if (m === '/liangce/inbound') return m
  return m
})
// force the post URL
bridge = bridge.replace(
  /const url = `\$\{GATEWAY_HTTP[^`]+`/,
  "const url = `${GATEWAY_HTTP.replace(/\\/$/, '')}/liangce/inbound`"
)

fs.writeFileSync(p, bridge)
console.log('ok bytes', bridge.length)
console.log('postLiangce in handle', bridge.slice(start, start+600).includes('postLiangceInbound'))
const hm = bridge.match(/const url = `[^`]+`/)
console.log('url', hm && hm[0])

// Fix names: detect actual helper names in file
const names = {
  sendBrowser: /function sendBrowser\(|const sendBrowser/.test(bridge),
  sendBrowser2: /function sendBrowser\(|sendBrowser\(/.test(bridge),
  ensureGateway: /function ensureGateway\(|async function ensureGateway/.test(bridge),
  extractAssistantDelta: /function extractAssistantDelta/.test(bridge),
  postLiangceInbound: /function postLiangceInbound|async function postLiangceInbound/.test(bridge),
  REQUIRE_HANDOFF: /REQUIRE_HANDOFF/.test(bridge),
}
console.log('names', names)
