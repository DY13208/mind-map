import { io } from 'socket.io-client'
import { getRuntimeConfig } from './runtimeConfig'
import { resolveFileRef } from './fileApi'
import { normalizeMapRef } from './mapRefNav'
import { withMirrorForwardSuppressed } from './mapRefMirror'

const plainTitle = text => String(text || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()

// Resolve only the references already present in the preview, before its first
// paint. Do not persist derived labels or fetch entire referenced maps.
export async function resolveInitialMapRefTitles(tree, {
  request = resolveFileRef,
  isCurrent = () => true,
  timeoutMs = 1500,
  concurrency = 4
} = {}) {
  const targets = new Map()
  const walk = node => {
    if (!node || !node.data) return
    const ref = normalizeMapRef(node.data.mapRef)
    if (ref) {
      const key = JSON.stringify([ref.mapId, ref.nodeId || null])
      if (!targets.has(key)) targets.set(key, { ref, nodes: [] })
      targets.get(key).nodes.push(node)
    }
    const children = node.children || []
    children.forEach(walk)
  }
  walk(tree)
  if (!targets.size || !isCurrent()) return tree
  const jobs = [...targets.values()]
  let active = true
  let index = 0
  let timer
  const worker = async () => {
    while (active && isCurrent() && index < jobs.length) {
      const { ref, nodes } = jobs[index++]
      try {
        const info = await request(ref.mapId, ref.nodeId || undefined)
        if (!active || !isCurrent() || !info || !info.exists || (ref.nodeId && !info.nodeExists)) continue
        const text = plainTitle(ref.nodeId ? info.nodeText : info.title)
        if (text) nodes.forEach(node => {
          Object.assign(node.data, { text, richText: false, resetRichText: true })
        })
      } catch (_) {
        // Missing/inaccessible targets retain their last known label.
      }
    }
  }
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker)),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })
    ])
  } finally {
    active = false
    clearTimeout(timer)
  }
  return tree
}

// Titles are derived display data. Never send a node edit back to the source
// or the host room merely because a referenced map was renamed.
export class MapTitleSync {
  constructor({ mindMap, roomKey, onTitle, onRoomChanged, request = resolveFileRef, createSocket = io }) {
    this.map = mindMap
    this.roomKey = roomKey
    this.onTitle = onTitle
    this.onRoomChanged = onRoomChanged
    this.request = request
    this.createSocket = createSocket
    this.rooms = new Map()
    this.pending = new Map()
    this.stopped = true
    this.onDataChange = this.onDataChange.bind(this)
  }

  rootTitle() {
    const root = this.map.renderer && this.map.renderer.renderTree
    return plainTitle(root && root.data && root.data.text)
  }

  start() {
    this.stopped = false
    this.lastRoot = this.rootTitle()
    const cfg = getRuntimeConfig()
    this.socket = this.createSocket(cfg.collabApi, {
      path: '/collab-v2', withCredentials: true,
      transports: ['websocket', 'polling']
    })
    this.socket.on('connect', () => {
      this.rooms.forEach((_, key) => this.watch(key))
    })
    this.socket.on('op:event', event => {
      const key = event && (event.roomKey || event.room_key || event.mapId)
      if (this.rooms.has(key)) {
        this.schedule(key)
        if (this.onRoomChanged) this.onRoomChanged(key)
      }
    })
    this.socket.on('sync:resnapshot-required', event => {
      const key = event && (event.roomKey || event.room_key)
      if (this.rooms.has(key)) this.schedule(key)
    })
    this.map.on('data_change', this.onDataChange)
    this.map.on('node_tree_render_end', this.onDataChange)
    this.scan()
    // Reconcile after disconnection, missed events, or an older server without
    // observer support. Requests read only metadata, never entire maps.
    this.timer = setInterval(() => this.rooms.forEach((_, key) => this.schedule(key)), 5000)
  }

  watch(key) {
    this.socket.emit('map:watch', { roomKey: key }, result => {
      if (!this.stopped && this.rooms.has(key) && result && result.ok) this.schedule(key)
    })
  }

  scan() {
    if (this.stopped) return
    const next = new Map([[this.roomKey, []]])
    const walk = node => {
      if (!node || !node.data) return
      const ref = normalizeMapRef(node.data.mapRef)
      if (ref) {
        if (!next.has(ref.mapId)) next.set(ref.mapId, [])
        // Reconcile mirror labels independently of subtree version cursors.
        // This also covers references inside collapsed/unloaded branches.
        next.get(ref.mapId).push({ node, ref })
      }
      const children = node.children || []
      children.forEach(walk)
    }
    walk(this.map.renderer && this.map.renderer.renderTree)
    this.rooms.forEach((_, key) => {
      if (!next.has(key)) this.socket.emit('map:unwatch', { roomKey: key })
    })
    const previous = this.rooms
    this.rooms = next
    next.forEach((_, key) => {
      if (!previous.has(key)) {
        if (this.socket.connected) this.watch(key)
        this.schedule(key)
      } else {
        const oldRefs = new Set(previous.get(key).map(host => host.node.data.uid + ':' + (host.ref.nodeId || '')))
        if (next.get(key).some(host => !oldRefs.has(host.node.data.uid + ':' + (host.ref.nodeId || '')))) this.schedule(key)
      }
    })
  }

  onDataChange() {
    if (this.stopped || this.applying) return
    const title = this.rootTitle()
    if (title !== this.lastRoot) {
      this.lastRoot = title
      this.localTitle = title.slice(0, 80)
      this.localTitleAt = Date.now()
      if (title) this.onTitle({ roomKey: this.roomKey, title: title.slice(0, 80) })
    }
    // Coalesce renders and content events, including expand/collapse, so new
    // references and references hidden in collapsed branches are tracked.
    clearTimeout(this.scanTimer)
    this.scanTimer = setTimeout(() => this.scan(), 100)
  }

  schedule(key) {
    if (this.stopped) return
    if (this.pending.has(key)) {
      const pending = this.pending.get(key)
      if (pending.running) pending.dirty = true
      return
    }
    const task = { dirty: false }
    this.pending.set(key, task)
    task.timer = setTimeout(async () => {
      task.running = true
      try {
        do {
          task.dirty = false
          const info = await this.request(key)
          if (this.stopped || !this.rooms.has(key) || !info || !info.exists) return
          const title = plainTitle(info.title)
          const awaitingLocal = key === this.roomKey && this.localTitle && title !== this.localTitle && Date.now() - this.localTitleAt < 8000
          if (title && !awaitingLocal) this.onTitle({ roomKey: key, title })
          if (key === this.roomKey && title === this.localTitle) this.localTitle = ''
          const hosts = this.rooms.get(key) || []
          const nodeTitles = new Map()
          for (const host of hosts) {
            let text = title
            if (host.ref.nodeId) {
              if (!nodeTitles.has(host.ref.nodeId)) nodeTitles.set(host.ref.nodeId, await this.request(key, host.ref.nodeId))
              const nodeInfo = nodeTitles.get(host.ref.nodeId)
              if (!nodeInfo || !nodeInfo.exists || !nodeInfo.nodeExists) continue
              text = plainTitle(nodeInfo.nodeText)
            }
            if (this.stopped || !this.rooms.has(key)) return
            this.applyTitle(host, text)
          }
        } while (task.dirty && !this.stopped)
      } catch (_) {
        // Deleted or inaccessible maps retain their last display name.
      } finally {
        if (this.pending.get(key) === task) this.pending.delete(key)
      }
    }, 100)
  }

  applyTitle(host, text) {
    // Hydration can replace the render tree while the metadata request is in
    // flight. Resolve the current host instead of updating a detached snapshot.
    const uid = host.node.data.uid
    let node = null
    const walk = current => {
      if (!current || node) return
      if (current.data && current.data.uid === uid) node = current
      else (current.children || []).forEach(walk)
    }
    walk(this.map.renderer.renderTree)
    if (!node) return
    const data = node.data
    const current = normalizeMapRef(data.mapRef)
    if (!text || !current || current.mapId !== host.ref.mapId || current.nodeId !== host.ref.nodeId || plainTitle(data.text) === text) return
    this.applying = true
    const cooperate = this.map.cooperate
    const wasRemote = cooperate && cooperate.isApplyingRemote
    if (cooperate) cooperate.isApplyingRemote = true
    try {
      const live = this.map.renderer.findNodeByUid(data.uid)
      const patch = { text, richText: false, resetRichText: true }
      if (live) withMirrorForwardSuppressed(() => this.map.renderer.setNodeDataRender(live, patch))
      else Object.assign(data, patch)
    } finally {
      if (cooperate) cooperate.isApplyingRemote = wasRemote
      this.applying = false
    }
  }

  stop() {
    this.stopped = true
    clearInterval(this.timer)
    clearTimeout(this.scanTimer)
    this.pending.forEach(task => clearTimeout(task.timer))
    this.pending.clear()
    this.map.off('data_change', this.onDataChange)
    this.map.off('node_tree_render_end', this.onDataChange)
    if (this.socket) this.socket.disconnect()
  }
}
