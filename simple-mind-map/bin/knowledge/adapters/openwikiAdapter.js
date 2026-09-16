const fs = require('fs/promises')
const { readCanonical } = require('./canonicalInput')
async function health(options = {}) {
  const configDir = options.configDir || process.env.OPENWIKI_CONFIG_DIR || '/data/openwiki'
  try { await fs.access(configDir); return { adapter: 'openwiki', configAccessible: true, runtime: 'on_demand_cli', syncImplemented: false } }
  catch (_) { return { adapter: 'openwiki', configAccessible: false, runtime: 'on_demand_cli', syncImplemented: false } }
}
module.exports = { health, readCanonical }
