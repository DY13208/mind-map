#!/usr/bin/env node
/**
 * Mint a Knowledge MCP (Wiki 读取) access token.
 *
 * Usage:
 *   node scripts/wiki-mcp-token.js [userId] [--ttl 2592000]
 *   node scripts/wiki-mcp-token.js [userId] --ttl 0   # permanent (no exp)
 *
 * userId    mind-map 用户 id（默认取 .env 的 AUTH_DEV_BYPASS_USER_ID，即本机身份）
 * --ttl     秒，默认取 .env 的 KNOWLEDGE_MCP_JWT_TTL_SEC，再退回 180；0=永久
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

/** Same rules as knowledgeMcpToken / knowledge-mcp jwt: 0 is permanent, not default. */
function parseJwtTtlSec(raw, defaultTtl = 180) {
  if (raw === undefined || raw === null) return defaultTtl;
  const text = String(raw).trim();
  if (text === '') return defaultTtl;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return defaultTtl;
  return Math.floor(n);
}

const env = { ...readEnvFile(path.join(ROOT, '.env')), ...process.env };

const args = process.argv.slice(2);
const ttlFlag = args.indexOf('--ttl');
const ttlSec = parseJwtTtlSec(
  ttlFlag >= 0 ? args[ttlFlag + 1] : env.KNOWLEDGE_MCP_JWT_TTL_SEC,
  180
);
const positional = args.filter((a, i) => {
  if (ttlFlag >= 0 && (i === ttlFlag || i === ttlFlag + 1)) return false;
  if (a === '--json' || String(a).startsWith('--')) return false;
  return true;
});
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
  jti: crypto.randomUUID(),
};
if (ttlSec > 0) {
  payload.exp = now + ttlSec;
}
const data = `${b64(header)}.${b64(payload)}`;
const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
const token = `${data}.${sig}`;

if (args.includes('--json')) {
  console.log(
    JSON.stringify({
      token,
      userId,
      ttlSec,
      permanent: ttlSec === 0,
      expiresAt:
        ttlSec > 0 ? new Date((now + ttlSec) * 1000).toISOString() : null,
    })
  );
} else {
  console.log(token);
  console.error(
    ttlSec > 0
      ? `# sub=${userId} ttl=${ttlSec}s 到期=${new Date((now + ttlSec) * 1000).toISOString()}`
      : `# sub=${userId} ttl=0 永久 Token（无 exp）`
  );
}
