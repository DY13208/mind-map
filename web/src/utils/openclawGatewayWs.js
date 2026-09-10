/**
 * 浏览器侧：经同源 /openclaw-bridge/ws 连良策 bridge，再由 bridge 走龙虾 Gateway WS。
 * 事件：delta / tool / done / error / status
 */
const TOOL_PROGRESS_LINE =
  /^(?:\[\d+(?:\/\d+)?\]\s*)?([a-zA-Z][\w./:-]{0,64})\s+(start|result|update|end|error|ok|done)\s*$/i

function isToolProgressNoise(text) {
  const s = String(text || '').trim()
  if (!s) return false
  const lines = s
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  if (!lines.length) return false
  return lines.every(l => TOOL_PROGRESS_LINE.test(l))
}

function parseToolProgressNoise(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(TOOL_PROGRESS_LINE)
    if (m) return { name: m[1], phase: String(m[2] || '').toLowerCase(), detail: '' }
  }
  return null
}

function looksLikePartialToolLine(text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (/[\u4e00-\u9fff]/.test(t)) return false
  return /^[a-zA-Z][\w./:-]{0,64}(?:\s+[a-zA-Z]*)?$/.test(t)
}

function resolveBridgeWsUrl() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  if (runtime.openclawBridgeWs) {
    const v = String(runtime.openclawBridgeWs)
    if (v.startsWith('ws://') || v.startsWith('wss://')) return v
    if (v.startsWith('/') && typeof window !== 'undefined') {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${proto}//${window.location.host}${v}`
    }
  }
  if (typeof window === 'undefined') return 'ws://127.0.0.1:18790/ws'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/openclaw-bridge/ws`
}

/**
 * @param {object} opts
 * @param {string} opts.message
 * @param {string} [opts.conversationId]
 * @param {AbortSignal} [opts.signal]
 * @param {(text: string) => void} [opts.onDelta]
 * @param {(info: {name:string,phase:string,detail:string}) => void} [opts.onTool]
 * @param {(info: {ok:boolean}) => void} [opts.onStatus]
 */
export function streamOpenclawGatewayWs(opts = {}) {
  const {
    message,
    conversationId,
    signal,
    onDelta,
    onTool,
    onStatus
  } = opts
  const url = resolveBridgeWsUrl()
  const chatId =
    Date.now().toString(36) +
    Math.random()
      .toString(36)
      .slice(2, 8)

  return new Promise((resolve, reject) => {
    let settled = false
    let full = ''
    let lineBuf = ''
    let ws
    try {
      ws = new WebSocket(url)
    } catch (err) {
      reject(err)
      return
    }

    const finish = (err, content) => {
      if (settled) return
      settled = true
      try {
        if (ws && ws.readyState <= 1) ws.close()
      } catch (e) {
        /* ignore */
      }
      if (err) reject(err)
      else resolve({ content: content || full })
    }

    const emitDelta = text => {
      if (!text) return
      full += text
      if (onDelta) onDelta(text)
    }

    const emitToolFromNoise = text => {
      const info = parseToolProgressNoise(text)
      if (info && onTool) onTool(info)
    }

    const pushDeltaChunk = chunk => {
      const raw = String(chunk || '')
      if (!raw) return
      lineBuf += raw
      const parts = lineBuf.split(/\r?\n/)
      lineBuf = parts.pop() || ''
      let out = ''
      for (const part of parts) {
        if (part.trim() && isToolProgressNoise(part)) {
          emitToolFromNoise(part)
          continue
        }
        out += part + '\n'
      }
      if (lineBuf) {
        if (isToolProgressNoise(lineBuf)) {
          emitToolFromNoise(lineBuf)
        } else if (!looksLikePartialToolLine(lineBuf)) {
          out += lineBuf
          lineBuf = ''
        }
      }
      emitDelta(out)
    }

    const onAbort = () => {
      finish(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'chat',
          id: chatId,
          conversationId: conversationId || chatId,
          message: String(message || '')
        })
      )
    }
    ws.onmessage = ev => {
      let msg
      try {
        msg = JSON.parse(String(ev.data || ''))
      } catch (e) {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'status' && onStatus) {
        onStatus({ ok: !!msg.ok })
        return
      }
      if (msg.id && msg.id !== chatId && msg.type !== 'status') return
      if (msg.type === 'delta' && msg.text) {
        pushDeltaChunk(msg.text)
        return
      }
      if (msg.type === 'tool' && onTool) {
        onTool({
          name: msg.name || 'tool',
          phase: msg.phase || '',
          detail: msg.detail || ''
        })
        return
      }
      if (msg.type === 'done') {
        if (lineBuf && !isToolProgressNoise(lineBuf)) {
          emitDelta(lineBuf)
          lineBuf = ''
        } else if (lineBuf && isToolProgressNoise(lineBuf)) {
          emitToolFromNoise(lineBuf)
          lineBuf = ''
        }
        if (msg.text && !full) {
          const cleaned = String(msg.text)
            .split(/\r?\n/)
            .filter(l => !(l.trim() && isToolProgressNoise(l)))
            .join('\n')
          if (cleaned) emitDelta(cleaned)
        }
        finish(null, full)
        return
      }
      if (msg.type === 'error') {
        finish(new Error(msg.message || 'OpenClaw bridge error'))
      }
    }
    ws.onerror = () => {
      finish(new Error('无法连接 OpenClaw Bridge（请确认 Start-Docker 已拉起）'))
    }
    ws.onclose = () => {
      if (!settled) {
        if (lineBuf && !isToolProgressNoise(lineBuf)) {
          emitDelta(lineBuf)
          lineBuf = ''
        }
        if (full) finish(null, full)
        else finish(new Error('连接已关闭'))
      }
    }
  })
}

export function getOpenclawBridgeWsUrl() {
  return resolveBridgeWsUrl()
}
