const { spawn } = require('child_process')
const path = require('path')

const children = [
  { name: 'api', script: 'api.js' },
  { name: 'worker', script: 'worker.js' },
  { name: 'mcp', script: 'mcp.js' }
]

const running = new Map()
let stopping = false

function launch(entry) {
  const child = spawn(process.execPath, [path.join(__dirname, entry.script)], {
    stdio: 'inherit',
    env: process.env
  })
  running.set(entry.name, child)
  child.on('exit', code => {
    running.delete(entry.name)
    if (stopping) return
    console.error(`[file-knowledge] ${entry.name} 退出 code=${code}，1 秒后只重启该进程`)
    setTimeout(() => {
      if (!stopping) launch(entry)
    }, 1000)
  })
}

function stop() {
  stopping = true
  for (const child of running.values()) child.kill()
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
children.forEach(launch)
console.log('[file-knowledge] 已分别启动 API、解析进程和 MCP。停止其中一个不会停止脑图服务。')
