const express = require('express')
const axios = require('axios')
const net = require('net')
const {
  initAuth,
  applyCorsHeaders,
  isAllowedOrigin,
  requireAuthenticatedRequest
} = require('../../simple-mind-map/bin/auth')

const port = 3456

const isPortUsed = port => {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', err => {
      if (err.code === 'EADDRINUSE') {
        resolve(true) // 端口被占用
      } else {
        resolve(false) // 其他错误
      }
    })
    server.once('listening', () => {
      server.close(() => resolve(false)) // 端口可用
    })
    server.listen(port) // 尝试监听端口
  })
}

const createServe = async () => {
  await initAuth()
  // 起个服务
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))

  // 登录启用时仅允许应用自身携带会话跨域；未启用时保持原来的局域网兼容性。
  app.use((req, res, next) => {
    applyCorsHeaders(req, res)
    if (req.method === 'OPTIONS') {
      res.status(isAllowedOrigin(req) ? 204 : 403).end()
      return
    }
    next()
  })

  app.use(async (req, res, next) => {
    try {
      const authenticated = await requireAuthenticatedRequest(req, res)
      if (authenticated) next()
    } catch (err) {
      next(err)
    }
  })

  // 监听对话请求
  app.get('/ai/test', (req, res) => {
    res
      .json({
        code: 0,
        data: null,
        msg: '连接成功'
      })
      .end()
  })
  app.post('/ai/chat', async (req, res, next) => {
    // 设置SSE响应头
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const { api, method = 'POST', headers = {}, data } = req.body

    try {
      const response = await axios({
        url: api,
        method,
        headers,
        data,
        responseType: 'stream'
      })
      response.data.pipe(res)
    } catch (error) {
      next(error)
    }
  })

  app.listen(port, '0.0.0.0', () => {
    console.log(`AI server listening on http://0.0.0.0:${port}`)
  })
}

isPortUsed(port).then(isUsed => {
  if (isUsed) {
    console.error('端口被占用')
  } else {
    createServe().catch(err => {
      console.error('AI server failed to start:', err.message)
      process.exitCode = 1
    })
  }
})
