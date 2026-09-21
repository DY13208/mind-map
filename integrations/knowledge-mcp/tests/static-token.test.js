'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyToken, signToken } = require('../src/auth/jwt');
const { issueKnowledgeMcpToken } = require('../../../simple-mind-map/bin/knowledgeMcpToken');

const secret = 'test-secret-that-is-at-least-32-characters';

test('static user token is deterministic and has no expiry', () => {
  const env = {
    KNOWLEDGE_MCP_JWT_SECRET: secret,
    KNOWLEDGE_MCP_JWT_ISS: 'openclaw-liangce',
    KNOWLEDGE_MCP_JWT_AUD: 'knowledge-mcp',
  };
  const first = issueKnowledgeMcpToken('user-1', env);
  const second = issueKnowledgeMcpToken('user-1', env);
  assert.equal(first, second);

  const payload = verifyToken(first, { secret });
  assert.equal(payload.sub, 'user-1');
  assert.equal(payload.v, 2);
  assert.equal(payload.tokenUse, 'static');
  assert.equal(Object.hasOwn(payload, 'exp'), false);
});

test('static user token is invalid after the signing secret changes', () => {
  const token = issueKnowledgeMcpToken('user-1', {
    KNOWLEDGE_MCP_JWT_SECRET: secret,
  });
  assert.throws(
    () => verifyToken(token, { secret: `${secret}-rotated` }),
    error => error && error.code === 'bad_signature'
  );
});

test('legacy expiring tokens remain supported and still expire', () => {
  const current = signToken({ userId: 'user-1', secret, ttlSec: 60 });
  assert.equal(verifyToken(current.token, { secret }).sub, 'user-1');

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'user-1', actorType: 'user', iss: 'openclaw-liangce', aud: 'knowledge-mcp',
    iat: now - 120, exp: now - 60,
  })).toString('base64url');
  const data = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  assert.throws(
    () => verifyToken(`${data}.${signature}`, { secret }),
    error => error && error.code === 'expired'
  );
});
