export function getRuntimeConfig() {
  const runtime = (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const host =
    runtime.host ||
    (typeof window !== 'undefined' ? window.location.hostname : '') ||
    'localhost'
  const webPort = Number(runtime.webPort || 8081)
  const collabPort = Number(runtime.collabPort || 1234)
  const aiPort = Number(runtime.aiPort || 3456)
  const isHttps =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
  const wsProtocol = isHttps ? 'wss:' : 'ws:'
  const httpProtocol =
    typeof window !== 'undefined' ? window.location.protocol : 'http:'
  return {
    host,
    webPort,
    collabPort,
    aiPort,
    collabUrl: `${wsProtocol}//${host}:${collabPort}`,
    aiBaseUrl: `${httpProtocol}//${host}:${aiPort}`,
    appUrl: `${httpProtocol}//${host}:${webPort}`
  }
}

export function getAiBaseUrl(port) {
  const cfg = getRuntimeConfig()
  const protocol =
    typeof window !== 'undefined' ? window.location.protocol : 'http:'
  return `${protocol}//${cfg.host}:${port || cfg.aiPort}`
}
