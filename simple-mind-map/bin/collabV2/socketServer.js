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
const { isCollabV2Enabled } = require('./flag')
const { submitOperation, listOperations } = require('./sequencer')
const { isValidClientId, requireClientId } = require('./protocol')
const { createPresenceHub } = require('./presenceHub')
const { collabTrace } = require('./trace')

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

function attachCollabV2(httpServer, options = {}) {
  if (!isCollabV2Enabled()) {
    return { io: null, presence: null, enabled: false }
  }
  const presence = createPresenceHub()
  const io = new Server(httpServer, {
    path: '/collab-v2',
    cors: { origin: true, credentials: true },
    pingInterval: 20000,
    pingTimeout: 20000,
    maxHttpBufferSize: 8 * 1024 * 1024
  })

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
    socket.data.clientId = String(
      (socket.handshake &&
        socket.handshake.auth &&
        socket.handshake.auth.clientId) ||
        ''
    ).trim()
    socket.data.canEdit = {}

    const emitPresence = throttle((roomKey) => {
      io.to('v2:' + roomKey).emit('presence:state', {
        roomKey,
        peers: presence.list(roomKey)
      })
    }, 80)

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
        const sync = await listOperations(req, roomKey, last, 500)
        const version = await getRoomVersion(roomKey)
        const metaRow = await getRoomMetadata(roomKey)
        const metadata = (metaRow && metaRow.metadata) || {}
        reply({
          ok: true,
          roomKey,
          role: access.role,
          canEdit: !!access.canEdit,
          canView: true,
          canManage: !!access.canManage,
          legacyOpen: !!access.legacyOpen,
          serverRevision: Number(version || 0),
          metadata,
          theme: metadata.theme,
          themeConfig: metadata.themeConfig,
          layout: metadata.layout,
          sync,
          peers: presence.list(roomKey)
        })
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
        const result = await submitOperation(req, {
          ...(body || {}),
          userId: (socket.authUser && socket.authUser.id) || (body && body.userId),
          clientId
        })
        if (result.access && roomKey) {
          socket.data.canEdit[roomKey] = !!result.access.canEdit
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
        if (!result.duplicate) {
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
          body && body.limit
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
    }, 80)

    socket.on('presence', onPresence)

    socket.on('disconnect', () => {
      socket.data.rooms.forEach(roomKey => {
        presence.removePeer(roomKey, socket.data.clientId || socket.id)
        io.to('v2:' + roomKey).emit('presence:state', {
          roomKey,
          peers: presence.list(roomKey)
        })
      })
    })
  })

  return { io, presence, enabled: true }
}

function shouldHandleUpgrade(url) {
  const path = String(url || '')
  return path.startsWith('/collab-v2') || path.startsWith('/socket.io')
}

module.exports = { attachCollabV2, shouldHandleUpgrade }
