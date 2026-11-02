// Public links must preserve the external HTTPS origin, including its port.
// Internal API addresses and the origins of other applications are independent.
function publicAppOrigin(env = process.env, fallbackOrigin = '') {
  const configured = String(env.AUTH_APP_ORIGIN || '').trim()
  const candidate = configured || fallbackOrigin ||
    `http://${env.PUBLIC_HOST || '127.0.0.1'}:${Number(env.WEB_PORT || 8989)}`
  let url
  try { url = new URL(candidate) } catch (_) {
    throw new Error('Invalid public application origin')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Public application origin must contain only protocol, host and port')
  }
  return url.origin
}

module.exports = { publicAppOrigin }
