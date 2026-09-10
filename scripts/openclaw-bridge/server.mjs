/**
 * OpenClaw Gateway bridge for 良策助理页.
 * 本机 Node 以 gateway-client/backend 身份连龙虾，再向浏览器暴露简化 WebSocket。
 *
 * 浏览器协议（JSON 文本帧）：
 *   → { type:'chat', id, conversationId, message }
 *   ← { type:'delta', id, text }
 *   ← { type:'tool', id, name, phase, detail }
 *   ← { type:'done', id, text }
 *   ← { type:'error', id, message }
 *   ← { type:'status', ok, connected }
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { GatewayClient } from '@openclaw/gateway-client'
import { PROTOCOL_VERSION } from '@openclaw/gateway-protocol/version'
import { GATEWAY_CLIENT_CAPS } from '@openclaw/gateway-protocol/client-info'

const PORT = Number(process.env.OPENCLAW_BRIDGE_PORT || 18790)
const GATEWAY_URL =
  process.env.OPENCLAW_GATEWAY_WS ||
  `ws://127.0.0.1:${process.env.OPENCLAW_PORT || 18791}`
const TOKEN = String(process.env.OPENCLAW_GATEWAY_TOKEN || '').trim()

if (!TOKEN) {
  console.error('[openclaw-bridge] missing OPENCLAW_GATEWAY_TOKEN')
  process.exit(1)
}

/** @type {import('@openclaw/gateway-client').GatewayClient | null} */
let gateway = null
let gatewayReady = false
const browserClients = new Set()
/** runId -> { browserWs, chatId, text, seq } */
const runs = new Map()

function sendBrowser(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload))
}

function broadcastStatus() {
  const msg = JSON.stringify({
    type: 'status',
    ok: gatewayReady,
    connected: gatewayReady
  })
  for (const ws of browserClients) {
    if (ws.readyState === 1) ws.send(msg)
  }
}

function isToolProgressText(text) {
  const s = String(text || '').trim()
  if (!s) return false
  const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (!lines.length) return false
  const re =
    /^(?:\[\d+(?:\/\d+)?\]\s*)?([a-zA-Z][\w./:-]{0,64})\s+(start|result|update|end|error|ok|done)\s*$/i
  return lines.every(l => re.test(l))
}

function extractAssistantDelta(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const data = payload.data || payload
  // 工具流字段误入正文时直接丢弃
  if (
    data.name &&
    (data.phase || data.status || data.state) &&
    !data.delta &&
    !data.text &&
    !(typeof data.content === 'string' && data.content)
  ) {
    return ''
  }
  const candidates = [
    data.delta,
    data.text,
    data.content,
    data.message,
    payload.delta,
    payload.text
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c) {
      if (isToolProgressText(c)) return ''
      return c
    }
    if (c && typeof c === 'object') {
      if (typeof c.text === 'string' && c.text) {
        if (isToolProgressText(c.text)) return ''
        return c.text
      }
      if (typeof c.delta === 'string' && c.delta) {
        if (isToolProgressText(c.delta)) return ''
        return c.delta
      }
    }
  }
  return ''
}

function extractToolInfo(payload) {
  const data = (payload && (payload.data || payload)) || {}
  return {
    name: String(data.name || data.toolName || data.tool || 'tool'),
    phase: String(data.phase || data.status || data.state || 'update'),
    detail: String(
      data.detail ||
        data.summary ||
        data.label ||
        data.argsPreview ||
        data.error ||
        ''
    ).slice(0, 500)
  }
}

function onGatewayEvent(evt) {
  const name = String((evt && evt.event) || '')
  const payload = (evt && evt.payload) || {}
  const runId = String(
    payload.runId || (payload.data && payload.data.runId) || ''
  )
  const stream = String(payload.stream || '')

  // agent 事件：assistant / tool / lifecycle
  if (name === 'agent' || name.startsWith('agent.')) {
    const track = runId ? runs.get(runId) : null
    if (!track) return
    const seq = Number(payload.seq || 0)
    if (seq && track.seq && seq <= track.seq) return
    if (seq) track.seq = seq

    if (stream === 'assistant' || stream === 'message') {
      const delta = extractAssistantDelta(payload)
      if (delta) {
        // 累计全文时只推增量
        let piece = delta
        if (track.text && delta.startsWith(track.text)) {
          piece = delta.slice(track.text.length)
        }
        if (piece) {
          track.text += piece
          sendBrowser(track.browserWs, {
            type: 'delta',
            id: track.chatId,
            text: piece
          })
        }
      }
      return
    }
    if (stream === 'tool') {
      const info = extractToolInfo(payload)
      sendBrowser(track.browserWs, {
        type: 'tool',
        id: track.chatId,
        ...info
      })
      return
    }
    if (stream === 'lifecycle') {
      const phase = String(
        (payload.data && (payload.data.phase || payload.data.state)) || ''
      )
      if (phase === 'end' || phase === 'done' || phase === 'error') {
        sendBrowser(track.browserWs, {
          type: phase === 'error' ? 'error' : 'done',
          id: track.chatId,
          text: track.text,
          message:
            phase === 'error'
              ? String((payload.data && payload.data.error) || 'run failed')
              : undefined
        })
        runs.delete(runId)
      }
      return
    }
  }

  // chat 事件兜底
  if (name === 'chat' || name === 'chat.delta' || name === 'session.message') {
    const track = runId ? runs.get(runId) : null
    if (!track) return
    const delta = extractAssistantDelta(payload)
    if (delta) {
      let piece = delta
      if (track.text && delta.startsWith(track.text)) {
        piece = delta.slice(track.text.length)
      }
      if (piece) {
        track.text += piece
        sendBrowser(track.browserWs, {
          type: 'delta',
          id: track.chatId,
          text: piece
        })
      }
    }
  }
}

function connectGateway() {
  const connected = Promise.withResolvers
    ? Promise.withResolvers()
    : (() => {
        let resolve
        let reject
        const promise = new Promise((res, rej) => {
          resolve = res
          reject = rej
        })
        return { promise, resolve, reject }
      })()

  gateway = new GatewayClient({
    url: GATEWAY_URL,
    token: TOKEN,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    // 默认即为 gateway-client / backend（loopback 可省略 device）
    caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
    onHelloOk: () => {
      gatewayReady = true
      broadcastStatus()
      connected.resolve()
      console.log('[openclaw-bridge] gateway hello-ok')
    },
    onConnectError: err => {
      gatewayReady = false
      broadcastStatus()
      connected.reject(err)
      console.error(
        '[openclaw-bridge] connect error',
        (err && err.message) || err
      )
    },
    onClose: () => {
      gatewayReady = false
      broadcastStatus()
      console.warn('[openclaw-bridge] gateway closed')
    },
    onEvent: onGatewayEvent
  })
  gateway.start()
  return connected.promise
}

async function ensureGateway() {
  if (gatewayReady && gateway) return
  await connectGateway()
}

async function handleChat(ws, msg) {
  const chatId = String(msg.id || randomUUID())
  const conversationId = String(msg.conversationId || randomUUID())
  const message = String(msg.message || '').trim()
  if (!message) {
    sendBrowser(ws, { type: 'error', id: chatId, message: '空消息' })
    return
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

  const sessionKey = `main:liangce:${conversationId}`
  try {
    // 优先 chat.send（Control UI 同源）
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
      runs.set(runId, {
        browserWs: ws,
        chatId,
        text: '',
        seq: 0
      })
    } else {
      // 同步返回正文的兜底
      const text = extractAssistantDelta(result) || String(result || '')
      if (text) {
        sendBrowser(ws, { type: 'delta', id: chatId, text })
      }
      sendBrowser(ws, { type: 'done', id: chatId, text })
    }
  } catch (err) {
    // chat.send 不可用时回退 agent
    try {
      const runId = randomUUID()
      runs.set(runId, { browserWs: ws, chatId, text: '', seq: 0 })
      await gateway.request(
        'agent',
        {
          sessionKey,
          message,
          runId
        },
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

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, gateway: gatewayReady }))
    return
  }
  res.writeHead(404)
  res.end('not found')
})

const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', ws => {
  browserClients.add(ws)
  sendBrowser(ws, { type: 'status', ok: gatewayReady, connected: gatewayReady })
  ws.on('message', raw => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch (e) {
      sendBrowser(ws, { type: 'error', message: 'invalid json' })
      return
    }
    if (msg && msg.type === 'chat') {
      handleChat(ws, msg)
      return
    }
    if (msg && msg.type === 'ping') {
      sendBrowser(ws, { type: 'pong' })
    }
  })
  ws.on('close', () => {
    browserClients.delete(ws)
    for (const [runId, track] of runs) {
      if (track.browserWs === ws) runs.delete(runId)
    }
  })
})

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[openclaw-bridge] listening ws://127.0.0.1:${PORT}/ws`)
  try {
    await ensureGateway()
  } catch (err) {
    console.error(
      '[openclaw-bridge] initial gateway connect failed (will retry on chat):',
      (err && err.message) || err
    )
  }
})
