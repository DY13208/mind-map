'use strict';
const crypto = require('crypto');

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function signToken({
  userId,
  secret,
  ttlSec = 180,
  iss = 'openclaw-liangce',
  aud = 'knowledge-mcp',
  actorType = 'user',
}) {
  if (!secret) throw new Error('missing_secret');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: String(userId),
    actorType,
    iss,
    aud,
    iat: now,
    exp: now + Number(ttlSec),
    jti: crypto.randomUUID(),
  };
  const data = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return { token: `${data}.${sig}`, payload };
}

function verifyToken(token, {
  secret,
  iss = 'openclaw-liangce',
  aud = 'knowledge-mcp',
  allowedActorTypes = ['user'],
} = {}) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3) {
    const e = new Error('invalid_token');
    e.code = 'invalid_token';
    throw e;
  }
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const e = new Error('bad_signature');
    e.code = 'bad_signature';
    throw e;
  }
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== iss) { const e = new Error('bad_iss'); e.code = 'bad_iss'; throw e; }
  if (payload.aud !== aud) { const e = new Error('bad_aud'); e.code = 'bad_aud'; throw e; }
  if (!payload.exp || now > Number(payload.exp)) { const e = new Error('expired'); e.code = 'expired'; throw e; }
  if (!payload.iat || Number(payload.iat) > now + 60) { const e = new Error('bad_iat'); e.code = 'bad_iat'; throw e; }
  if (!allowedActorTypes.includes(String(payload.actorType || ''))) {
    const e = new Error('bad_actor'); e.code = 'bad_actor'; throw e;
  }
  if (!String(payload.sub || '').trim()) { const e = new Error('missing_sub'); e.code = 'missing_sub'; throw e; }
  return payload;
}

function extractBearer(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return String((req.headers && req.headers['x-knowledge-token']) || '').trim() || null;
}

module.exports = { signToken, verifyToken, extractBearer };
