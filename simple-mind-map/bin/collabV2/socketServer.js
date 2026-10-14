const { Server } = require('socket.io')
const { isAuthEnabled, authenticateWebsocketRequest } = require('../auth')
const roomAcl = require('../roomAcl')
const {
  getPool,
  getRoomVersion,
  getRoomMetadata,
  safeRoomKey,
  isDeletedRoom
} = require('../storage')
const {
  isCollabV2Enabled,
  isCollabV2EventBridgeEnabled
} = require('./flag')
const { submitOperation, listOperations } = require('./sequencer')
const { isValidClientId, requireClientId } = require('./protocol')
const { createPresenceHub } = require('./presenceHub')
const mcpPresence = require('./mcpPresence')
const { collabTrace } = require('./trace')

let activeOperationEventBridge = null

function getOperationEventBridgeStatus() {
  return activeOperationEventBridge
    ? activeOperationEventBridge.status()
    : {
        enabled: false,
        listenerHealthy: false,
        activeRooms: 0,
        pendingDrains: 0,
        queueLength: 0,
        laggingRooms: 0
      }
}

function throttle(fn, ms) {
  let timer = null
  let last = 0
  return function wrapped(...args) {
    const now = Date.now()
    const remain = ms - (now - last)
    if (remain <= 0) {
      last = now
      fn.apply(this, args)
      return
    }
    clearTimeout(timer)
    timer = setTimeout(() => {
      last = Date.now()
      fn.apply(this, args)
    }, remain)
  }
}

// 同一连接连续编辑时复用刚通过的编辑权限，不再每次保存都查 3~4 条权限 SQL。
// 撤权最多延迟这么久生效；被拒或分享失效时立即清掉。
const EDIT_ACCESS_TTL_MS = 5000
const PRESENCE_BROADCAST_MS = 250

function presenceSignature(peers) {
  return JSON.stringify(
    (peers || []).map(peer => [
      peer.clientId,
      peer.userId || '',
      peer.name || '',
      peer.color || '',
      peer.avatar || '',
      peer.role || '',
      peer.editingUid || null,
      peer.selectedUids || [],
      peer.cursor || null
    ])
  )
}

function attachCollabV2(httpServer, options = {}) {
  if (!isCollabV2Enabled()) {
    return { io: null, presence: null, enabled: false }
  }
  const presence = createPresenceHub()
  const presenceSent = new Map()
  const presenceTimers = new Map()

  // 房间级合并：多人同时动选区时一轮只发一次，内容没变就不发。
  function broadcastPresence(roomKey, { immediate = false } = {}) {
    const send = () => {
      presenceTimers.delete(roomKey)
      const peers = [...presence.list(roomKey), ...mcpPresence.list(roomKey)]
      const sig = presenceSignature(peers)
      if (presenceSent.get(roomKey) === sig) return
      if (peers.length) presenceSent.set(roomKey, sig)
      else presenceSent.delete(roomKey)
      io.to('v2:' + roomKey).emit('presence:state', { roomKey, peers })
    }
    if (immediate) {
      clearTimeout(presenceTimers.get(roomKey))
      send()
      return
    }
    if (presenceTimers.has(roomKey)) return
    const timer = setTimeout(send, PRESENCE_BROADCAST_MS)
    if (timer.unref) timer.unref()
    presenceTimers.set(roomKey, timer)
  }

  const io = new Server(httpServer, {
    path: '/collab-v2',
    cors: { origin: true, credentials: true },
    pingInterval: 20000,
    pingTimeout: 20000,
    maxHttpBufferSize: 8 * 1024 * 1024
  })
  const onMcpPresence = roomKey => broadcastPresence(roomKey)
  mcpPresence.changes.on('change', onMcpPresence)
  const mcpPresenceTimer = setInterval(() => mcpPresence.prune(), 5000)
  mcpPresenceTimer.unref()

  let operationEventBridge = null
  if (isCollabV2EventBridgeEnabled()) {
    const storage = require('../storage')
    const { createOperationEventBridge } = require('./operationEventBridge')
    operationEventBridge = createOperationEventBridge({
      bus: options.eventBus,
      io,
      listRoomOperationsContiguous: storage.listRoomOperationsContiguous,
      listActiveRoomHeads: storage.listActiveRoomHeads,
      getActiveRoomKeys: () => {
        const active = new Set()
        const sockets = io.sockets && io.sockets.sockets
        if (sockets && typeof sockets.values === 'function') {
          for (const socket of sockets.values()) {
            if (!socket.connected || !socket.data || !socket.data.bridgeRooms) continue
            socket.data.bridgeRooms.forEach(roomKey => active.add(roomKey))
          }
        }
        return Array.from(active)
      },
      invalidateRoomState: async roomKey => {
        if (typeof storage.invalidateRoomCache === 'function') {
          storage.invalidateRoomCache(roomKey)
        }
        if (typeof storage.dropLiveDoc === 'function') {
          storage.dropLiveDoc(roomKey)
        }
      },
      intervalMs: 1000,
      pageSize: options.eventBridgePageSize
    })
    activeOperationEventBridge = operationEventBridge
    operationEventBridge.start().catch(err => {
      console.error('[collab-v2] event bridge start failed', (err && err.code) || 'ERROR')
    })
  }

  io.use(async (socket, next) => {
    try {
      const req = socket.request
      if (process.env.COLLAB_TEST_ACL === '1') {
        const auth = (socket.handshake && socket.handshake.auth) || {}
        const userId = String(auth.userId || '').trim()
        if (!userId) {
          const err = new Error('unauthorized')
          err.data = { code: 'unauthorized', statusCode: 401 }
          return next(err)
        }
        socket.authUser = { id: userId, name: auth.name || userId }
        socket.testAcl = true
        return next()
      }
      if (!isAuthEnabled()) {
        socket.authUser = { id: 'anonymous', name: 'anonymous' }
        return next()
      }
      socket.authUser = await authenticateWebsocketRequest(req)
      if (!socket.authUser) {
        const err = new Error('unauthorized')
        err.data = { code: 'unauthorized', statusCode: 401 }
        return next(err)
      }
      next()
    } catch (err) {
      err.data = { code: err.code || 'unauthorized', statusCode: err.statusCode || 401 }
      next(err)
    }
  })

  io.on('connection', socket => {
    socket.data.rooms = new Set()
    socket.data.bridgeRooms = new Set()
    socket.data.clientId = String(
      (socket.handshake &&
        socket.handshake.auth &&
        socket.handshake.auth.clientId) ||
        ''
    ).trim()
    socket.data.canEdit = {}
    socket.data.editAccess = new Map()
    socket.data.shareRooms = new Set()
    let checkingShareAccess = false
    const shareAccessTimer = setInterval(async () => {
      if (checkingShareAccess || !socket.connected || !socket.data.shareRooms.size) return
      checkingShareAccess = true
      try {
        const req = Object.assign(socket.request, {
          authUser: socket.authUser,
          forceAcl: !!socket.testAcl
        })
        for (const roomKey of socket.data.shareRooms) {
          const access = await roomAcl.assertRoomAccess(getPool(), req, roomKey, 'view')
          if (!access.shareId) socket.data.shareRooms.delete(roomKey)
          socket.data.canEdit[roomKey] = !!access.canEdit
          if (!access.canEdit) socket.data.editAccess.delete(roomKey)
        }
      } catch (err) {
        socket.data.editAccess.clear()
        socket.disconnect(true)
      } finally {
        checkingShareAccess = false
      }
    }, 10000)
    shareAccessTimer.unref()

    const emitPresence = roomKey => broadcastPresence(roomKey)

    const cachedEditAccess = roomKey => {
      const hit = socket.data.editAccess.get(roomKey)
      if (!hit) return null
      if (Date.now() - hit.at > EDIT_ACCESS_TTL_MS) {
        socket.data.editAccess.delete(roomKey)
        return null
      }
      return hit.access
    }

    socket.on('join', async (body, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {}
      try {
        const roomKey = safeRoomKey(body && body.roomKey)
        const clientId = String(
          (body && body.clientId) ||
            (socket.handshake && socket.handshake.auth && socket.handshake.auth.clientId) ||
            ''
        ).trim()
        if (!roomKey) {
          reply({ ok: false, code: 'BAD_REQUEST', error: '缺少 roomKey' })
          return
        }
        if (!isValidClientId(clientId)) {
          reply({
            ok: false,
            code: 'INVALID_CLIENT_ID',
            error: 'clientId 不能为空',
            statusCode: 400
          })
          return
        }
        if (isDeletedRoom(roomKey)) {
          reply({ ok: false, code: 'NOT_FOUND', error: 'not found', statusCode: 404 })
          return
        }
        const req = Object.assign(socket.request, {
          authUser: socket.authUser,
          forceAcl: !!socket.testAcl
        })
        const access = await roomAcl.assertRoomAccess(getPool(), req, roomKey, 'view')
        socket.data.clientId = clientId
        socket.data.canEdit[roomKey] = !!access.canEdit
        socket.data.editAccess.delete(roomKey)
        if (access.shareId) socket.data.shareRooms.add(roomKey)
        collabTrace('join.identity', {
          roomKey,
          userId: access.userId || (socket.authUser && socket.authUser.id) || '',
          clientId,
          socketId: socket.id,
          lastServerRevision: Math.max(0, Number(body && body.lastServerRevision) || 0)
        })
        socket.join('v2:' + roomKey)
        socket.data.rooms.add(roomKey)
        presence.setPeer(roomKey, clientId, {
          userId: access.userId || (socket.authUser && socket.authUser.id) || '',
          name: (body && body.name) || (socket.authUser && socket.authUser.name) || '',
          avatar: (body && body.avatar) || (socket.authUser && socket.authUser.avatar) || '',
          color: (body && body.color) || '#409EFF',
          role: access.role,
          selectedUids: [],
          editingUid: null
        })
        const last = Math.max(0, Number(body && body.lastServerRevision) || 0)
        const version = await getRoomVersion(roomKey)
        const headVersion = Math.max(0, Number(version) || 0)
        const sync = await listOperations(req, roomKey, last, 500, {
          viewAccess: access,
          headVersion
        })
        const metaRow = await getRoomMetadata(roomKey)
        const metadata = (metaRow && metaRow.metadata) || {}
        reply({
          ok: true,
          roomKey,
          role: access.role,
          canEdit: !!access.canEdit,
          canView: true,
          canManage: !!access.canManage,
          shareId: access.shareId || null,
          legacyOpen: !!access.legacyOpen,
          serverRevision: headVersion,
          metadata,
          theme: metadata.theme,
          themeConfig: metadata.themeConfig,
          layout: metadata.layout,
          sync,
          peers: [...presence.list(roomKey), ...mcpPresence.list(roomKey)]
        })
        if (operationEventBridge) {
          operationEventBridge.activateRoom(roomKey, headVersion)
          socket.data.bridgeRooms.add(roomKey)
        }
        emitPresence(roomKey)
      } catch (err) {
        reply({
          ok: false,
          code: err.code || 'FORBIDDEN',
          error: err.message,
          statusCode: err.statusCode || 403
        })
      }
    })

    socket.on('op', async (body, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {}
      try {
        const req = Object.assign(socket.request, {
          authUser: socket.authUser,
          forceAcl: !!socket.testAcl
        })
        const roomKey = safeRoomKey((body && (body.roomKey || body.room_key)) || '')
        const clientId = isValidClientId(socket.data.clientId)
          ? String(socket.data.clientId).trim()
          : String((body && (body.clientId || body.client_id)) || '').trim()
        requireClientId(clientId)
        socket.data.clientId = clientId
        const editAccess =
          roomKey && socket.data.rooms.has(roomKey) ? cachedEditAccess(roomKey) : null
        const result = await submitOperation(
          req,
          {
            ...(body || {}),
            userId: (socket.authUser && socket.authUser.id) || (body && body.userId),
            clientId
          },
          { editAccess }
        )
        if (result.access && roomKey) {
          socket.data.canEdit[roomKey] = !!result.access.canEdit
          if (result.access.canEdit && !editAccess) {
            socket.data.editAccess.set(roomKey, { access: result.access, at: Date.now() })
          }
        }
        const op = result.operation
        reply({
          ok: true,
          opId: op.opId,
          serverRevision: op.serverRevision,
          duplicate: result.duplicate,
          operation: op,
          queryStats: result.queryStats || null
        })
        if (!result.duplicate && !operationEventBridge) {
          const roomName = 'v2:' + op.roomKey
          let size = 0
          try {
            const room =
              socket.adapter && socket.adapter.rooms && socket.adapter.rooms.get
                ? socket.adapter.rooms.get(roomName)
                : null
            size = room && room.size != null ? room.size : 0
          } catch (err) {
            size = 0
          }
          socket.to(roomName).emit('op:event', op)
          collabTrace('9.broadcast', {
            traceId: (body && body.traceId) || (op.payload && op.payload.traceId),
            room: op.roomKey,
            recipientCount: Math.max(0, size - 1),
            opId: op.opId,
            clientId: op.clientId,
            actorId: op.userId
          })
        }
      } catch (err) {
        const failedRoom = safeRoomKey((body && (body.roomKey || body.room_key)) || '')
        if (failedRoom) socket.data.editAccess.delete(failedRoom)
        if (failedRoom && (err.statusCode === 403 || err.code === 'FORBIDDEN')) {
          socket.data.canEdit[failedRoom] = false
        }
        reply({
          ok: false,
          opId: body && (body.opId || body.operationId),
          code: err.code || 'OP_REJECTED',
          error: err.message,
          statusCode: err.statusCode || 400,
          currentVersion: err.currentVersion,
          details: {
            ...(err.details || {}),
            baseRevision:
              (err.details &&
                (err.details.baseRevision != null
                  ? err.details.baseRevision
                  : err.details.baseVersion)) != null
                ? err.details.baseRevision != null
                  ? err.details.baseRevision
                  : err.details.baseVersion
                : body && (body.baseRevision != null ? body.baseRevision : body.baseVersion),
            roomCurrentRevision:
              err.currentVersion != null
                ? err.currentVersion
                : err.details && err.details.roomCurrentRevision,
            clientSeq: body && body.clientSeq,
            opId: body && (body.opId || body.operationId)
          }
        })
      }
    })

    socket.on('sync', async (body, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {}
      try {
        const req = Object.assign(socket.request, {
          authUser: socket.authUser,
          forceAcl: !!socket.testAcl
        })
        const roomKey = safeRoomKey(body && body.roomKey)
        const result = await listOperations(
          req,
          roomKey,
          body && body.afterRevision,
          body && body.limit,
          body && body.headVersion != null
            ? { headVersion: body.headVersion }
            : undefined
        )
        reply({ ok: true, ...result })
      } catch (err) {
        reply({
          ok: false,
          code: err.code || 'SYNC_FAILED',
          error: err.message,
          statusCode: err.statusCode || 400
        })
      }
    })

    const onPresence = throttle(async (body) => {
      const roomKey = safeRoomKey(body && body.roomKey)
      if (!roomKey || !socket.data.rooms.has(roomKey)) return
      const clientId = socket.data.clientId || socket.id
      if (body && body.editingUid) {
        const owner = presence.lockOwner(roomKey, body.editingUid)
        if (owner && owner.clientId !== clientId) {
          socket.emit('lock:denied', {
            roomKey,
            nodeId: body.editingUid,
            owner
          })
          return
        }
      }
      presence.setPeer(roomKey, clientId, {
        selectedUids: body.selectedUids,
        editingUid: body.editingUid,
        name: body.name,
        color: body.color,
        avatar: body.avatar,
        cursor: body.cursor
      })
      emitPresence(roomKey)
    }, PRESENCE_BROADCAST_MS)

    socket.on('presence', onPresence)

    socket.on('disconnect', () => {
      clearInterval(shareAccessTimer)
      socket.data.editAccess.clear()
      socket.data.rooms.forEach(roomKey => {
        presence.removePeer(roomKey, socket.data.clientId || socket.id)
        broadcastPresence(roomKey, { immediate: true })
        if (
          typeof options.onRoomIdle === 'function' &&
          presence.list(roomKey).length === 0
        ) {
          Promise.resolve(options.onRoomIdle(roomKey)).catch(err => {
            console.error('[history] room idle flush', err && err.message)
          })
        }
      })
    })
  })

  async function stop() {
    clearInterval(mcpPresenceTimer)
    mcpPresence.changes.off('change', onMcpPresence)
    if (operationEventBridge) {
      await operationEventBridge.stop()
      if (activeOperationEventBridge === operationEventBridge) {
        activeOperationEventBridge = null
      }
    }
  }

  return { io, presence, enabled: true, operationEventBridge, stop }
}

function shouldHandleUpgrade(url) {
  const path = String(url || '')
  return path.startsWith('/collab-v2') || path.startsWith('/socket.io')
}

module.exports = {
  attachCollabV2,
  shouldHandleUpgrade,
  getOperationEventBridgeStatus
}
