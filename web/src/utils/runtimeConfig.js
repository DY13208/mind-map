function defaultPort(protocol) {
  return protocol === 'https:' ? 443 : 80
}

function pagePort(loc) {
  if (loc && loc.port) return Number(loc.port)
  return defaultPort((loc && loc.protocol) || 'http:')
}

function useSameOrigin(runtime, loc) {
  if (runtime.gateway === true || runtime.gateway === 'true') return true
  if (!loc || !loc.hostname) return true
  if (!runtime.host) return true
  if (String(runtime.host) !== String(loc.hostname)) return true
  const webPort = Number(runtime.webPort || 0)
  const current = pagePort(loc)
  if (webPort && current && current !== webPort) return true
  if (current === 80 || current === 443 || current === 8989 || current === 8080) {
    return true
  }
  return false
}

export function getRuntimeConfig() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const loc = typeof window !== 'undefined' ? window.location : {}
  const host = loc.hostname || runtime.host || 'localhost'
  const sameOrigin = useSameOrigin(runtime, loc)
  const webPort = Number(runtime.webPort || loc.port || 8081)
  const collabPort = Number(runtime.collabPort || 1234)
  const aiPort = Number(runtime.aiPort || 3456)
  const mcpPort = Number(runtime.mcpPort || 3847)
  const isHttps =
    typeof window !== 'undefined' && loc.protocol === 'https:'
  const wsProtocol = isHttps ? 'wss:' : 'ws:'
  const httpProtocol =
    typeof window !== 'undefined' ? loc.protocol : 'http:'
  const originHttp =
    typeof window !== 'undefined' ? loc.origin : `${httpProtocol}//${host}`
  const originWs = `${wsProtocol}//${
    typeof window !== 'undefined' ? loc.host : host
  }`
      if (sameOrigin) {
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
      collabV2: runtime.collabV2 !== false && runtime.collabV2 !== '0',
      collabV2Trace:
        runtime.collabV2Trace === true || runtime.collabV2Trace === '1',
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
    host: runtime.host || host,
    webPort,
    collabPort,
    aiPort,
    mcpPort,
    publicPath: runtime.publicPath || '',
    collabUrl: `${wsProtocol}//${runtime.host || host}:${collabPort}`,
    collabApi: `${httpProtocol}//${runtime.host || host}:${collabPort}`,
    collabV2: runtime.collabV2 !== false && runtime.collabV2 !== '0',
    collabV2Trace:
      runtime.collabV2Trace === true || runtime.collabV2Trace === '1',
    aiBaseUrl: `${httpProtocol}//${runtime.host || host}:${aiPort}`,
    mcpUrl: `${httpProtocol}//${runtime.host || host}:${mcpPort}/mcp`,
    appUrl: `${httpProtocol}//${runtime.host || host}:${webPort}`,
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
