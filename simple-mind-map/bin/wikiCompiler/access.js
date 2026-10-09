const crypto = require('node:crypto')

function secret(env) {
  const value = String(env.WIKI_COMPILER_INTERNAL_SECRET || '')
  if (value.length < 32) throw Object.assign(new Error('wiki_compiler_unconfigured'), { code: 'wiki_compiler_unconfigured' })
  return value
}
function unauthorized() {
  return Object.assign(new Error('unauthorized'), { code: 'unauthorized', statusCode: 401 })
}
function issueIdentity(userId, env = process.env, now = Math.floor(Date.now() / 1000)) {
  if (!userId || typeof userId !== 'string' || userId.length > 256) throw unauthorized()
  const body = Buffer.from(JSON.stringify({ sub: userId, aud: 'wiki-compiler', iat: now, exp: now + 30 })).toString('base64url')
  return body + '.' + crypto.createHmac('sha256', secret(env)).update(body).digest('base64url')
}
function verifyIdentity(token, env = process.env, now = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').split('.')
  if (parts.length !== 2 || parts[0].length > 2048) throw unauthorized()
  const expected = crypto.createHmac('sha256', secret(env)).update(parts[0]).digest()
  const actual = Buffer.from(parts[1], 'base64url')
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw unauthorized()
  let body
  try { body = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) } catch (_) { throw unauthorized() }
  if (body.aud !== 'wiki-compiler' || typeof body.sub !== 'string' || !body.sub || body.sub.length > 256 ||
      !Number.isFinite(body.exp) || !Number.isFinite(body.iat) || body.exp <= now || body.iat > now + 5 || body.exp - body.iat !== 30) throw unauthorized()
  return body.sub
}
async function readableRooms(pool, userId, env = process.env) {
  const normalize = value => /^wecom:[a-f0-9]{48}$/i.test(String(value)) ? String(value) : String(value).replace(/^wecom:/i, '')
  userId = normalize(userId)
  const admins = String(env.MIND_MAP_SUPER_ADMIN_IDS || '').split(/[,;\s]+/).filter(Boolean).map(normalize)
  let admin = admins.includes(userId)
  if (admins.length && !admin) {
    const member = (await pool.query('select wecom_userid from wecom_users where user_id=$1', [userId])).rows[0]
    admin = !!member && admins.includes(normalize(member.wecom_userid))
  }
  const rows = (await pool.query(`select r.room_key from rooms r
    left join room_tombstones t using(room_key)
    where r.deleted_at is null and t.room_key is null
    and ($2::boolean or not exists (select 1 from room_members all_members where all_members.room_key=r.room_key) or exists (
      select 1 from room_members m where m.room_key=r.room_key and m.user_id=$1 and m.role in ('owner','editor','viewer')))
    order by r.room_key`, [userId, admin])).rows
  return new Set(rows.map(r => r.room_key))
}
module.exports = { issueIdentity, verifyIdentity, readableRooms }
