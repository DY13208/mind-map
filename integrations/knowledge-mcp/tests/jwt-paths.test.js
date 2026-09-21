'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { signToken, verifyToken, parseJwtTtlSec } = require('../src/auth/jwt');
const { resolveUnder } = require('../src/utils/paths');
const { issueKnowledgeMcpToken } = require('../../../simple-mind-map/bin/knowledgeMcpToken');

test('jwt roundtrip', () => {
  const secret = 'x'.repeat(32);
  const { token, payload } = signToken({ userId: 'u1', secret, ttlSec: 120 });
  const got = verifyToken(token, { secret, ttlSec: 120 });
  assert.equal(got.sub, 'u1');
  assert.equal(got.jti, payload.jti);
  assert.ok(got.exp);
});

test('jwt rejects wrong aud', () => {
  const secret = 'y'.repeat(32);
  const { token } = signToken({ userId: 'u1', secret, aud: 'other', ttlSec: 120 });
  assert.throws(
    () => verifyToken(token, { secret, aud: 'knowledge-mcp', ttlSec: 120 }),
    /bad_aud/
  );
});

test('MCP access page issues deterministic static token without exp', () => {
  const secret = 's'.repeat(32);
  const env = { KNOWLEDGE_MCP_JWT_SECRET: secret };
  const first = issueKnowledgeMcpToken('u-static', env);
  const second = issueKnowledgeMcpToken('u-static', env);
  assert.equal(first, second);
  const payload = JSON.parse(
    Buffer.from(first.split('.')[1], 'base64url').toString('utf8')
  );
  assert.equal(payload.v, 2);
  assert.equal(payload.tokenUse, 'static');
  assert.equal(Object.hasOwn(payload, 'exp'), false);
  assert.equal(verifyToken(first, { secret }).sub, 'u-static');
});

test('Case1b: default mode rejects expired legacy token', () => {
  const secret = 'e'.repeat(32);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url'
  );
  const body = Buffer.from(
    JSON.stringify({
      sub: 'u-exp',
      actorType: 'user',
      iss: 'openclaw-liangce',
      aud: 'knowledge-mcp',
      iat: now - 120,
      exp: now - 10,
    })
  ).toString('base64url');
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  assert.throws(
    () => verifyToken(`${data}.${sig}`, { secret, ttlSec: 7776000 }),
    (err) => err.code === 'expired'
  );
});

test('Case2: TTL=3600 sets exp ≈ now+3600 and rejects after expiry', () => {
  const secret = 'z'.repeat(32);
  const before = Math.floor(Date.now() / 1000);
  const { token, payload } = signToken({ userId: 'u2', secret, ttlSec: 3600 });
  const after = Math.floor(Date.now() / 1000);
  assert.ok(payload.exp >= before + 3600);
  assert.ok(payload.exp <= after + 3600);
  assert.equal(verifyToken(token, { secret, ttlSec: 3600 }).sub, 'u2');

  const expiredPayload = { ...payload, exp: before - 1 };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url'
  );
  const body = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  assert.throws(
    () => verifyToken(`${data}.${sig}`, { secret, ttlSec: 3600 }),
    (err) => err.code === 'expired'
  );
});

test('Case3: TTL=0 permanent token via signToken has no exp', () => {
  const secret = 'p'.repeat(32);
  const { token, payload } = signToken({ userId: 'u-perm', secret, ttlSec: 0 });
  assert.equal(Object.hasOwn(payload, 'exp'), false);
  assert.equal(verifyToken(token, { secret, ttlSec: 0 }).sub, 'u-perm');
});

test('Case3b: permanent/static still rejects bad signature', () => {
  const secret = 'p'.repeat(32);
  const token = issueKnowledgeMcpToken('u-perm', { KNOWLEDGE_MCP_JWT_SECRET: secret });
  const tampered = token.slice(0, -4) + 'xxxx';
  assert.throws(
    () => verifyToken(tampered, { secret }),
    (err) => err.code === 'bad_signature'
  );
});

test('Case3c: TTL>0 verifier rejects non-static token without exp', () => {
  const secret = 'q'.repeat(32);
  const { token } = signToken({ userId: 'u-noexp', secret, ttlSec: 0 });
  assert.throws(
    () => verifyToken(token, { secret, ttlSec: 7776000 }),
    (err) => err.code === 'expired'
  );
});

test('Case4: illegal TTL config falls back to default, not permanent', () => {
  assert.equal(parseJwtTtlSec('abc', 7776000), 7776000);
  assert.equal(parseJwtTtlSec('-1', 7776000), 7776000);
  assert.equal(parseJwtTtlSec(0, 7776000), 0);
  assert.equal(parseJwtTtlSec('0', 7776000), 0);
});

test('path traversal blocked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kmcp-'));
  assert.throws(() => resolveUnder(root, '../etc/passwd'));
  assert.throws(() => resolveUnder(root, 'a/../../b'));
});
