const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const envPath = path.resolve(__dirname, '..', '.env')
const key = 'MIND_MAP_YIRAN_SSO_SECRET'

if (!fs.existsSync(envPath)) {
  console.error('[error] 缺少项目根目录 .env')
  process.exit(1)
}

let content = fs.readFileSync(envPath, 'utf8')
const linePattern = new RegExp(`^${key}=(.*)$`, 'm')
const matched = content.match(linePattern)
const existing = matched ? matched[1].trim().replace(/^['"]|['"]$/g, '') : ''

if (existing && existing.length < 32) {
  console.error(`[error] ${key} 至少需要 32 个字符`)
  process.exit(1)
}

if (!existing) {
  const secret = crypto.randomBytes(48).toString('base64url')
  if (matched) content = content.replace(linePattern, `${key}=${secret}`)
  else content = `${content.replace(/\s*$/, '')}\n${key}=${secret}\n`
  fs.writeFileSync(envPath, content, 'utf8')
  console.log('[ok] 已生成 Mind-map / Yiran 单点登录共享密钥（仅保存在本机 .env）')
}
