#!/usr/bin/env node
/**
 * Mint a Knowledge MCP (Wiki 读取) access token.
 *
 * Usage:
 *   node scripts/wiki-mcp-token.js [userId] [--ttl 2592000]
 *
 * userId    mind-map 用户 id（默认取 .env 的 AUTH_DEV_BYPASS_USER_ID，即本机身份）
 * --ttl     秒，默认取 .env 的 KNOWLEDGE_MCP_JWT_TTL_SEC，再退回 180
 *
 * The token is signed with KNOWLEDGE_MCP_JWT_SECRET from .env and must match the
 * service's KNOWLEDGE_MCP_JWT_ISS / KNOWLEDGE_MCP_JWT_AUD.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...readEnvFile(path.join(ROOT, '.env')), ...process.env };

const args = process.argv.slice(2);
const ttlFlag = args.indexOf('--ttl');
const ttlSec = Number(
  ttlFlag >= 0 ? args[ttlFlag + 1] : env.KNOWLEDGE_MCP_JWT_TTL_SEC || 180,
);
const positional = args.filter((a, i) => i !== ttlFlag && i !== ttlFlag + 1);
const userId = positional[0] || env.AUTH_DEV_BYPASS_USER_ID || 'dev-local';

const secret = env.KNOWLEDGE_MCP_JWT_SECRET;
if (!secret) {
  console.error('缺少 KNOWLEDGE_MCP_JWT_SECRET（应在项目根 .env 中）');
  process.exit(1);
}

const b64 = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'HS256', typ: 'JWT' };
const payload = {
  sub: String(userId),
  actorType: 'user',
  iss: env.KNOWLEDGE_MCP_JWT_ISS || 'openclaw-liangce',
  aud: env.KNOWLEDGE_MCP_JWT_AUD || 'knowledge-mcp',
  iat: now,
  exp: now + Number(ttlSec),
  jti: crypto.randomUUID(),
};
const data = `${b64(header)}.${b64(payload)}`;
const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
const token = `${data}.${sig}`;

if (args.includes('--json')) {
  console.log(JSON.stringify({ token, userId, ttlSec, expiresAt: new Date((now + Number(ttlSec)) * 1000).toISOString() }));
} else {
  console.log(token);
  console.error(
    `# sub=${userId} ttl=${ttlSec}s 到期=${new Date((now + Number(ttlSec)) * 1000).toISOString()}`,
  );
}
