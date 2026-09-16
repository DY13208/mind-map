const { readCanonical } = require('./canonicalInput')
async function health(baseUrl = process.env.DOCMOST_INTERNAL_URL || 'http://docmost:3000') {
  const response = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(10000) })
  return { adapter: 'docmost', reachable: response.ok, httpStatus: response.status, syncImplemented: false }
}
module.exports = { health, readCanonical }
