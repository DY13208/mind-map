// Generates fresh development-only credentials; never reads/prints existing secrets.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
function ensureWikiEnv() {
  const dir = path.resolve(__dirname, '../.secrets')
  const file = path.join(dir, 'wiki.env')
  if (fs.existsSync(file)) return
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const secret = crypto.randomBytes(32).toString('hex')
  const password = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(file, `APP_SECRET=${secret}\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://docmost:${password}@docmost-db:5432/docmost\n`, { mode: 0o600, flag: 'wx' })
  console.log('[Wiki] generated development credentials in ignored .secrets/wiki.env')
}
if (require.main === module) ensureWikiEnv()
module.exports = { ensureWikiEnv }
