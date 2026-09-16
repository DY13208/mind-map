const crypto = require('crypto')

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  return value
}
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex')
function safeId(value) {
  const id = String(value || '')
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(id) || id === '.' || id === '..' || id.startsWith('.')) {
    const err = new Error('Unsafe knowledge path identifier')
    err.statusCode = 400
    throw err
  }
  return id
}
// Preserve existing safe UIDs, encode other UIDs without changing their identity.
const uidFile = uid => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,119}$/.test(String(uid)) ? String(uid) : 'uid-' + Buffer.from(String(uid)).toString('hex')
const branchPath = uid => 'branches/' + uidFile(uid) + '.md'
module.exports = { stable, hash, safeId, branchPath }
