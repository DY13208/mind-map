'use strict'
// Loaded only by the acceptance harness's owned child processes.
const fs = require('node:fs')
const path = require('node:path')
const file = process.env.MCP_GUARDS_METRICS_FILE
if (file && /[\\/]output[\\/]mcp-write-guards[\\/][a-f0-9]{12}[\\/]/.test(path.resolve(file))) {
  const sample = () => {
    const cpu = process.cpuUsage(), memory = process.memoryUsage()
    fs.appendFileSync(file, JSON.stringify({ time: Date.now(), cpuUs: cpu.user + cpu.system, rss: memory.rss, heapUsed: memory.heapUsed }) + '\n')
  }
  sample()
  setInterval(sample, 250).unref()
}
