import Vue from 'vue'

const STORAGE_KEY = 'liangce-chats'
const MAX_SESSIONS = 40
const MAX_MESSAGES = 80

function uid() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const data = raw ? JSON.parse(raw) : null
    if (data && Array.isArray(data.sessions)) {
      return {
        sessions: data.sessions,
        currentId: data.currentId || (data.sessions[0] && data.sessions[0].id) || ''
      }
    }
  } catch (e) {
    /* ignore */
  }
  return { sessions: [], currentId: '' }
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessions: chatState.sessions,
        currentId: chatState.currentId
      })
    )
  } catch (e) {
    /* quota */
  }
}

const saved = load()

export const chatState = Vue.observable({
  sessions: saved.sessions,
  currentId: saved.currentId,
  connected: null,
  sending: false
})

export function currentSession() {
  return chatState.sessions.find(item => item.id === chatState.currentId) || null
}

export function createSession() {
  const session = {
    id: uid(),
    title: '新对话',
    updatedAt: Date.now(),
    messages: []
  }
  chatState.sessions = [session, ...chatState.sessions].slice(0, MAX_SESSIONS)
  chatState.currentId = session.id
  persist()
  return session
}

export function selectSession(id) {
  if (!chatState.sessions.some(item => item.id === id)) return
  chatState.currentId = id
  persist()
}

export function ensureSession() {
  return currentSession() || createSession()
}

export function deleteSession(id) {
  chatState.sessions = chatState.sessions.filter(item => item.id !== id)
  if (chatState.currentId === id) {
    chatState.currentId = (chatState.sessions[0] && chatState.sessions[0].id) || ''
  }
  persist()
}

export function titleFromText(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return '新对话'
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean
}

export function appendMessage(role, content, extra = {}) {
  const session = ensureSession()
  const message = {
    id: uid(),
    role,
    content: content || '',
    status: extra.status || '',
    createdAt: Date.now()
  }
  session.messages = [...session.messages, message].slice(-MAX_MESSAGES)
  session.updatedAt = Date.now()
  if (role === 'user' && session.title === '新对话') {
    session.title = titleFromText(content)
  }
  persist()
  return message
}

export function patchMessage(id, patch) {
  const session = currentSession()
  if (!session) return
  session.messages = session.messages.map(item => {
    if (item.id !== id) return item
    return { ...item, ...patch }
  })
  session.updatedAt = Date.now()
  persist()
}
