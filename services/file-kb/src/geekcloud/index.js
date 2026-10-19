'use strict'
const { loadGeekcloudConfig } = require('./config')
const { createGeekcloudAdapter, createDbAudit } = require('./adapter')

// sdk = { Client, StreamableHTTPClientTransport } from @modelcontextprotocol/sdk, injected by the host
// process so this module resolves no node_modules of its own (file-kb-mcp copies src/ without them).
function createGeekcloud({ env = process.env, sdk, query, log = console.log } = {}) {
  const config = loadGeekcloudConfig(env)
  if (config.enabled && config.errors.length) log(`[file-kb] geekcloud misconfigured: ${config.errors.join('; ')}`)
  const adapter = createGeekcloudAdapter({ config, sdk, audit: query ? createDbAudit(query) : undefined })
  log(`[file-kb] geekcloud enabled=${config.enabled} configured=${config.configured} tools=${config.allowedTools.length} users=${config.allowedUsers.length}`)
  return { config, adapter }
}

module.exports = { createGeekcloud }
