import { getRuntimeConfig } from './runtimeConfig'
import { FetchTimeoutError, fetchWithTimeout } from './fetchWithTimeout'

const DEFAULT_TIMEOUT_MS = 20000

function apiBase() {
  return getRuntimeConfig().collabApi || ''
}

async function request(path, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
  let res
  try {
    res = await fetchWithTimeout(
      `${apiBase()}${path}`,
      {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        method: options.method || 'GET',
        body: options.body
      },
      timeoutMs
    )
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      throw new Error('协作服务响应超时，请稍后重试')
    }
    throw err
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(data.error || res.statusText || 'request failed')
    if (data.code) error.code = data.code
    error.statusCode = res.status
    throw error
  }
  return data
}

/** Cross-room SOP ledger list (Postgres mirror). */
export async function listSopLedger(params = {}) {
  const q = new URLSearchParams()
  if (params.roomKey) q.set('roomKey', params.roomKey)
  if (params.q) q.set('q', params.q)
  if (params.limit != null) q.set('limit', String(params.limit))
  const qs = q.toString()
  return request(`/api/sop-ledger${qs ? `?${qs}` : ''}`)
}

export async function getSopLedgerDetail(roomKey, nodeUid) {
  return request(
    `/api/sop-ledger/${encodeURIComponent(roomKey)}/nodes/${encodeURIComponent(
      nodeUid
    )}`
  )
}

export async function backfillSopLedger(roomKey) {
  return request('/api/sop-ledger/backfill', {
    method: 'POST',
    body: JSON.stringify({ roomKey })
  })
}

/** Assistant conversations in mind_map Postgres (audit / sync). */
export async function loadChatConversations() {
  return request('/api/chat/conversations')
}

export async function saveChatConversations(state) {
  return request('/api/chat/conversations', {
    method: 'PUT',
    body: JSON.stringify({
      conversations: (state && state.conversations) || [],
      activeId: (state && state.activeId) || ''
    })
  })
}
