const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const ROOT = 'D:\\mind-map'
function sh(cmd, opts={}) {
  console.log('>>', cmd)
  return execSync(cmd, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore','pipe','pipe'], ...opts })
}
function read(p){ return fs.readFileSync(path.join(ROOT,p),'utf8') }
function write(p,s){ fs.writeFileSync(path.join(ROOT,p),s); console.log('wrote', p, s.length) }

// --- 1) Ensure handoff secret in .env ---
const envPath = path.join(ROOT,'.env')
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath,'utf8') : ''
let secret = ''
const m = env.match(/^OPENCLAW_LIANGCE_HANDOFF_SECRET=(.+)$/m)
if (m && String(m[1]).trim().length >= 32) {
  secret = String(m[1]).trim()
} else {
  secret = crypto.randomBytes(32).toString('hex')
  if (/^OPENCLAW_LIANGCE_HANDOFF_SECRET=/m.test(env)) {
    env = env.replace(/^OPENCLAW_LIANGCE_HANDOFF_SECRET=.*$/m, 'OPENCLAW_LIANGCE_HANDOFF_SECRET='+secret)
  } else {
    env += '\n# Phase 2B-1 Liangce handoff (shared Mind Map <-> OpenClaw)\nOPENCLAW_LIANGCE_HANDOFF_SECRET='+secret+'\n'
  }
  fs.writeFileSync(envPath, env)
  console.log('set OPENCLAW_LIANGCE_HANDOFF_SECRET in .env')
}

// --- 2) Fix plugin package.json / openclaw.plugin.json ---
const pluginDir = 'integrations/openclaw/liangce-ingress'
write(pluginDir+'/package.json', JSON.stringify({
  name: '@mind-map/liangce-ingress',
  version: '0.1.0',
  private: true,
  type: 'module',
  main: './index.js',
  openclaw: {
    extensions: ['./index.js']
  }
}, null, 2)+'\n')
write(pluginDir+'/openclaw.plugin.json', JSON.stringify({
  id: 'liangce-ingress',
  name: 'Liangce Trusted Ingress',
  description: 'Phase 2B-1: verify Mind Map Signed Handoff and set host-trusted requesterSenderId',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      handoffSecret: { type: 'string', minLength: 32 }
    }
  }
}, null, 2)+'\n')

// --- 3) Patch bridge handleChat to require handoff + POST /liangce/inbound ---
let bridge = read('scripts/openclaw-bridge/server.mjs')
if (!bridge.includes('LIANGCE_INBOUND')) {
  // Add helpers after TOKEN const block
  const helper = `
const GATEWAY_HTTP =
  process.env.OPENCLAW_GATEWAY_HTTP ||
  \`http://127.0.0.1:\${process.env.OPENCLAW_PORT || 4623}\`
const REQUIRE_HANDOFF = String(process.env.OPENCLAW_REQUIRE_HANDOFF || '1') !== '0'

/** Phase 2B-1: identity path — Gateway token is transport only; identity from verified handoff. */
async function postLiangceInbound({ handoff, message, conversationId, messageId }) {
  const url = \`\${GATEWAY_HTTP.replace(/\\/$/, '')}/liangce/inbound\`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: \`Bearer \${TOKEN}\`
    },
    body: JSON.stringify({ handoff, message, conversationId, messageId })
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!res.ok) {
    const err = new Error(json.error || json.message || \`liangce inbound HTTP \${res.status}\`)
    err.code = json.code || 'liangce_inbound_http'
    err.status = res.status
    err.body = json
    throw err
  }
  return json
}
`
  if (!bridge.includes('postLiangceInbound')) {
    bridge = bridge.replace(
      /if \(!TOKEN\) \{[\s\S]*?process\.exit\(1\)\r?\n\}/,
      (m) => m + '\n' + helper
    )
  }

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

  // Identity path: never forge requesterSenderId via chat.send user= field
  if (handoff) {
    try {
      const json = await postLiangceInbound({
        handoff,
        message,
        conversationId,
        messageId: chatId
      })
      const reply = String(json.reply || (json.replies && json.replies.join('\\n')) || '')
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

  // Legacy fallback only when REQUIRE_HANDOFF=0 (dev)
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
      { sessionKey, message, idempotencyKey: chatId },
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
}
`
  bridge = bridge.replace(/async function handleChat\(ws, msg\) \{[\s\S]*?\n\}(?=\n\nconst server)/, newHandle.trimEnd())
  write('scripts/openclaw-bridge/server.mjs', bridge)
} else {
  console.log('bridge already patched')
}

// --- 4) Patch openclawGatewayWs to fetch handoff ---
const wsPath = 'web/src/utils/openclawGatewayWs.js'
let ws = read(wsPath)
if (!ws.includes('fetchOpenclawHandoff')) {
  const helper = `
async function fetchOpenclawHandoff(conversationId) {
  const headers = { 'Content-Type': 'application/json' }
  try {
    const token =
      (typeof localStorage !== 'undefined' &&
        (localStorage.getItem('authToken') ||
          localStorage.getItem('token') ||
          localStorage.getItem('mindmap.authToken'))) ||
      ''
    if (token) headers.Authorization = 'Bearer ' + token
  } catch (_) {}
  const res = await fetch('/api/openclaw/handoff', {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ conversationId: conversationId || '' }),
    cache: 'no-store'
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(
      (json && (json.error || json.message)) ||
        '获取 OpenClaw handoff 失败 HTTP ' + res.status
    )
    err.code = (json && json.code) || 'openclaw_handoff_http'
    err.status = res.status
    throw err
  }
  return json
}
`
  ws = ws.replace(
    /export function streamOpenclawGatewayWs/,
    helper + '\nexport function streamOpenclawGatewayWs'
  )
  // make the exported function async-capable: fetch handoff before send
  ws = ws.replace(
    /ws\.onopen = \(\) => \{\s*ws\.send\(\s*JSON\.stringify\(\{[\s\S]*?message: String\(message \|\| ''\)\s*\}\)\s*\)\s*\}/,
    `ws.onopen = async () => {
      let handoff = opts.handoff || ''
      try {
        if (!handoff) {
          const issued = await fetchOpenclawHandoff(conversationId || chatId)
          handoff = issued.handoff || issued.token || ''
        }
      } catch (err) {
        finish(err)
        return
      }
      if (!handoff) {
        finish(new Error('缺少 Signed Handoff'))
        return
      }
      ws.send(
        JSON.stringify({
          type: 'chat',
          id: chatId,
          conversationId: conversationId || chatId,
          message: String(message || ''),
          handoff
        })
      )
    }`
  )
  write(wsPath, ws)
} else {
  console.log('gateway ws already patched')
}

console.log('SECRET_LEN', secret.length)
console.log('done patch')
