const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')
const ROOT = 'D:\\mind-map'

function read(p){ return fs.readFileSync(path.join(ROOT,p),'utf8') }
function write(p,s){ fs.writeFileSync(path.join(ROOT,p), s); console.log('wrote', p, Buffer.byteLength(s)) }

// Fix bridge handleChat completely
let bridge = read('scripts/openclaw-bridge/server.mjs')

// Fix inbound URL if wrong
bridge = bridge.replace(/\/liangce\/inbound/g, '/liangce/inbound')
bridge = bridge.replace(/\/liangce\/inbound/g, '/liangce/inbound')
// normalize to what plugin registers
if (bridge.includes('/liangce/inbound') && !bridge.includes("'/liangce/inbound'") && !bridge.includes('`/liangce/inbound`') && !bridge.includes('"/liangce/inbound"')) {
  // keep
}

// Ensure helper posts to /liangce/inbound (plugin path)
bridge = bridge.replace(
  /\$\{GATEWAY_HTTP\.replace\(\/\\\/\$\/, ''\)\}\/liangce\/[a-z]+/g,
  "${GATEWAY_HTTP.replace(/\\/$/, '')}/liangce/inbound"
)

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

  // Identity path: Gateway token = transport only; identity from verified handoff via plugin
  if (handoff) {
    try {
      const json = await postLiangceInbound({
        handoff,
        message,
        conversationId,
        messageId: chatId
      })
      const reply = String(
        json.reply || (Array.isArray(json.replies) ? json.replies.join('\\n') : '') || ''
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

  // Legacy fallback only when REQUIRE_HANDOFF=0
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

const re = /async function handleChat\(ws, msg\) \{[\s\S]*?\n\}(?=\n\nconst server)/
if (!re.test(bridge)) {
  console.error('HANDLE_CHAT_PATTERN_MISS')
  // try alternate end anchor
  const re2 = /async function handleChat\(ws, msg\) \{[\s\S]*?\n\}(?=\n\nconst )/
  if (!re2.test(bridge)) {
    console.error('still miss; dumping markers')
    const i = bridge.indexOf('async function handleChat')
    console.log('idx', i, bridge.slice(i, i+200))
    process.exit(1)
  }
  bridge = bridge.replace(re2, newHandle)
} else {
  bridge = bridge.replace(re, newHandle)
}
write('scripts/openclaw-bridge/server.mjs', bridge)

// Align plugin path naming: use /liangce/inbound consistently (already)
// Strip BOM from plugin index
let plugin = read('integrations/openclaw/liangce-ingress/index.js')
if (plugin.charCodeAt(0) === 0xfeff) plugin = plugin.slice(1)
// Ensure route path is /liangce/inbound
plugin = plugin.replace(/\/liangce\/inbound/g, '/liangce/inbound')
plugin = plugin.replace(/path:\s*["']\/liangce\/inbound["']/g, 'path: "/liangce/inbound"')
write('integrations/openclaw/liangce-ingress/index.js', plugin)

// Fix frontend handoff URL if wrong
let ws = read('web/src/utils/openclawGatewayWs.js')
ws = ws.replace(/\/api\/openclaw\/handoff/g, '/api/openclaw/handoff')
write('web/src/utils/openclawGatewayWs.js', ws)

// Verify helper URL
const helperMatch = bridge.match(/const url = `[^`]+`/)
console.log('helper url template', helperMatch && helperMatch[0])
console.log('handle uses postLiangceInbound', /postLiangceInbound/.test(bridge.split('async function handleChat')[1].slice(0,800)))
