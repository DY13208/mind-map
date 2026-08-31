export function getRuntimeConfig() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const loc = typeof window !== 'undefined' ? window.location : {}
  const host =
    runtime.host || loc.hostname || 'localhost'
  const gateway = !!(runtime.gateway === true || runtime.gateway === 'true')
  const webPort = Number(runtime.webPort || loc.port || 8081)
  const collabPort = Number(runtime.collabPort || 1234)
  const aiPort = Number(runtime.aiPort || 3456)
  const mcpPort = Number(runtime.mcpPort || 3847)
  const isHttps =
    typeof window !== 'undefined' && loc.protocol === 'https:'
  const wsProtocol = isHttps ? 'wss:' : 'ws:'
  const httpProtocol =
    typeof window !== 'undefined' ? loc.protocol : 'http:'
  const originHttp = typeof window !== 'undefined' ? loc.origin : `${httpProtocol}//${host}`
  const originWs = `${wsProtocol}//${
    typeof window !== 'undefined' ? loc.host : host
  }`
  if (gateway) {
    return {
      gateway: true,
      host,
      webPort,
      collabPort,
      aiPort,
      mcpPort,
      publicPath: runtime.publicPath || '/',
      collabUrl: `${originWs}/collab`,
      collabApi: originHttp,
      aiBaseUrl: originHttp,
      mcpUrl: `${originHttp}/mcp`,
      appUrl: originHttp,
      workbuddyBase: runtime.workbuddyBase || '/wb-api',
      workbuddyKey: runtime.workbuddyKey || 'local',
      workbuddyModel: runtime.workbuddyModel || 'auto'
    }
  }
  return {
    gateway: false,
    host,
    webPort,
    collabPort,
    aiPort,
    mcpPort,
    publicPath: runtime.publicPath || '',
    collabUrl: `${wsProtocol}//${host}:${collabPort}`,
    collabApi: `${httpProtocol}//${host}:${collabPort}`,
    aiBaseUrl: `${httpProtocol}//${host}:${aiPort}`,
    mcpUrl: `${httpProtocol}//${host}:${mcpPort}/mcp`,
    appUrl: `${httpProtocol}//${host}:${webPort}`,
    workbuddyBase: runtime.workbuddyBase || '/wb-api',
    workbuddyKey: runtime.workbuddyKey || 'local',
    workbuddyModel: runtime.workbuddyModel || 'auto'
  }
}

export function getAiBaseUrl(port) {
  const cfg = getRuntimeConfig()
  if (cfg.gateway) return cfg.aiBaseUrl
  const protocol =
    typeof window !== 'undefined' ? window.location.protocol : 'http:'
  return `${protocol}//${cfg.host}:${port || cfg.aiPort}`
}
