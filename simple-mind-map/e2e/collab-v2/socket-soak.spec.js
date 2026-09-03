const { test, expect } = require('@playwright/test')
const { io } = require('socket.io-client')
const { startStack } = require('./server')

function connectOnce(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      path: '/collab-v2',
      transports: ['websocket'],
      reconnection: false,
      timeout: 8000
    })
    const timer = setTimeout(() => {
      socket.removeAllListeners()
      socket.close()
      reject(new Error('socket connect timeout'))
    }, 8000)
    socket.on('connect', () => {
      clearTimeout(timer)
      socket.close()
      resolve(true)
    })
    socket.on('connect_error', err => {
      clearTimeout(timer)
      socket.close()
      reject(err)
    })
  })
}

test.describe('socket soak @soak', () => {
  test('100 connect/disconnect keep the collab process alive', async () => {
    test.setTimeout(180000)
    const stack = await startStack({ auth: false, collabV2: 1 })
    try {
      const direct = 'http://127.0.0.1:' + stack.collabPort
      const gateway = stack.origin
      for (let i = 0; i < 80; i++) {
        await connectOnce(direct)
        expect(stack.child.exitCode, 'collab process exited at direct #' + i).toBeNull()
      }
      for (let i = 0; i < 20; i++) {
        await connectOnce(gateway)
        expect(stack.child.exitCode, 'collab process exited at gateway #' + i).toBeNull()
      }
      const health = await fetch(stack.api + '/api/health')
      expect(health.ok).toBeTruthy()
    } finally {
      await stack.close()
    }
  })
})
